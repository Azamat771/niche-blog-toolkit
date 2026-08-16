'use strict';
/**
 * Минимальный FTP/FTPS-клиент на встроенных модулях Node (net + tls).
 * Нужен ровно для одного сценария: обход дерева открытых данных ЕИС
 * (ftp.zakupki.gov.ru) и скачивание ZIP-архивов.
 *
 * Поддерживает: USER/PASS, TYPE I, PASV, LIST, RETR, SIZE, explicit FTPS
 * (AUTH TLS + PBSZ/PROT) с переиспользованием TLS-сессии на канале данных.
 */

const net = require('net');
const tls = require('tls');

class FtpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FtpError';
    this.code = code;
  }
}

class FtpClient {
  constructor(opts = {}) {
    this.host = opts.host;
    this.port = opts.port || 21;
    this.user = opts.user || 'anonymous';
    this.password = opts.password || 'anonymous@';
    this.secure = !!opts.secure;
    this.timeout = opts.timeout || 60000;
    this.verbose = !!opts.verbose;

    this.control = null;
    this.buffer = '';
    this.responses = [];
    this.waiters = [];
    this.fatal = null;
    this.tlsSession = null;
  }

  log(...args) {
    if (this.verbose) console.error('[ftp]', ...args);
  }

  // --- канал управления -----------------------------------------------------

  async connect() {
    this.control = await this._openSocket(this.host, this.port);
    this._attachReader(this.control);

    const hello = await this._take();
    this._expect(hello, [220]);

    if (this.secure) {
      const auth = await this.send('AUTH TLS');
      this._expect(auth, [234]);
      this.control = await this._upgrade(this.control);
      this._attachReader(this.control);
      this._expect(await this.send('PBSZ 0'), [200]);
      this._expect(await this.send('PROT P'), [200]);
    }

    const userRes = await this.send(`USER ${this.user}`);
    if (userRes.code === 331) {
      this._expect(await this.send(`PASS ${this.password}`), [230, 202]);
    } else {
      this._expect(userRes, [230, 202]);
    }

    this._expect(await this.send('TYPE I'), [200]);
    return this;
  }

  async close() {
    if (!this.control) return;
    try {
      await this.send('QUIT');
    } catch {
      /* соединение уже могло умереть — это нормально при закрытии */
    }
    this.control.destroy();
    this.control = null;
  }

  _openSocket(host, port) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port });
      sock.setTimeout(this.timeout);
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const onTimeout = () => onError(new FtpError(`таймаут подключения к ${host}:${port}`));
      const cleanup = () => {
        sock.removeListener('error', onError);
        sock.removeListener('timeout', onTimeout);
      };
      sock.once('connect', () => {
        cleanup();
        sock.setTimeout(0);
        resolve(sock);
      });
      sock.once('error', onError);
      sock.once('timeout', onTimeout);
    });
  }

  _upgrade(socket, session) {
    return new Promise((resolve, reject) => {
      const secured = tls.connect(
        {
          socket,
          servername: this.host,
          session,
          // ЕИС отдаёт цепочку, которую не всегда принимает системный стор;
          // данные публичные, поэтому строгую проверку можно отключить флагом.
          rejectUnauthorized: process.env.ZAKUPKI_FTPS_STRICT === '1',
        },
        () => {
          this.tlsSession = secured.getSession() || this.tlsSession;
          resolve(secured);
        }
      );
      secured.once('error', reject);
    });
  }

  _attachReader(socket) {
    this.buffer = '';
    socket.setEncoding('utf8');
    socket.removeAllListeners('data');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      this._drain();
    });
    socket.on('error', (err) => this._fail(err));
    socket.on('close', () => this._fail(new FtpError('управляющее соединение закрыто')));
  }

  _fail(err) {
    if (this.fatal) return;
    this.fatal = err;
    while (this.waiters.length) this.waiters.shift().reject(err);
  }

  /** Вытаскивает из буфера все завершённые ответы (в т.ч. многострочные). */
  _drain() {
    for (;;) {
      const parsed = this._parseOne(this.buffer);
      if (!parsed) return;
      this.buffer = parsed.rest;
      this.log('<', parsed.response.code, parsed.response.text.split('\n')[0]);
      if (this.waiters.length) this.waiters.shift().resolve(parsed.response);
      else this.responses.push(parsed.response);
    }
  }

  _parseOne(buf) {
    const firstBreak = buf.indexOf('\n');
    if (firstBreak === -1) return null;
    const firstLine = buf.slice(0, firstBreak).replace(/\r$/, '');
    const head = /^(\d{3})([ -])/.exec(firstLine);
    if (!head) {
      // мусорная строка — выбрасываем, чтобы не залипнуть
      return { response: { code: 0, text: firstLine }, rest: buf.slice(firstBreak + 1) };
    }
    const code = Number(head[1]);
    if (head[2] === ' ') {
      return { response: { code, text: firstLine.slice(4) }, rest: buf.slice(firstBreak + 1) };
    }
    // многострочный ответ: ждём строку "<code> "
    const lines = buf.split('\n');
    const collected = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].replace(/\r$/, '');
      collected.push(line);
      if (i > 0 && line.startsWith(`${code} `)) {
        const consumed = collected.join('\n').length + 1;
        return {
          response: { code, text: collected.join('\n') },
          rest: buf.slice(consumed),
        };
      }
    }
    return null; // ответ ещё не дочитан
  }

  _take() {
    if (this.fatal) return Promise.reject(this.fatal);
    if (this.responses.length) return Promise.resolve(this.responses.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new FtpError('таймаут ожидания ответа сервера'));
      }, this.timeout);
      this.waiters.push({
        timer,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  send(command) {
    if (this.fatal) return Promise.reject(this.fatal);
    this.log('>', /^PASS /.test(command) ? 'PASS ****' : command);
    this.control.write(`${command}\r\n`);
    return this._take();
  }

  _expect(res, codes) {
    if (!codes.includes(res.code)) {
      throw new FtpError(`ожидались коды ${codes.join('/')}, получен ${res.code}: ${res.text}`, res.code);
    }
    return res;
  }

  // --- канал данных ---------------------------------------------------------

  async _pasv() {
    const res = await this.send('PASV');
    this._expect(res, [227]);
    const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(res.text);
    if (!m) throw new FtpError(`не разобран ответ PASV: ${res.text}`);
    const port = Number(m[5]) * 256 + Number(m[6]);
    // Хост из PASV часто внутренний (NAT) — надёжнее держаться исходного.
    return { host: this.host, port };
  }

  async _transfer(command) {
    const { host, port } = await this._pasv();
    let dataSocket = await this._openSocket(host, port);
    if (this.secure) dataSocket = await this._upgrade(dataSocket, this.tlsSession);

    const chunks = [];
    const finished = new Promise((resolve, reject) => {
      dataSocket.on('data', (c) => chunks.push(c));
      dataSocket.once('end', resolve);
      dataSocket.once('error', reject);
    });

    const pre = await this.send(command);
    if (pre.code >= 400) {
      dataSocket.destroy();
      throw new FtpError(`${command} отклонён: ${pre.code} ${pre.text}`, pre.code);
    }

    await finished;
    dataSocket.destroy();

    const post = await this._take();
    if (post.code >= 400) throw new FtpError(`${command} не завершён: ${post.code} ${post.text}`, post.code);
    return Buffer.concat(chunks);
  }

  /**
   * Листинг каталога. Возвращает [{ name, isDirectory, size, raw }].
   * Разбирает и unix-, и MS-DOS-формат вывода LIST.
   */
  async list(path) {
    const raw = (await this._transfer(`LIST ${path}`)).toString('utf8');
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = parseListLine(line);
      if (parsed && parsed.name !== '.' && parsed.name !== '..') entries.push(parsed);
    }
    return entries;
  }

  /** Скачивает файл целиком в память. Архивы ЕИС помещаются без проблем. */
  async download(path) {
    return this._transfer(`RETR ${path}`);
  }
}

/** Разбор одной строки листинга FTP (unix `ls -l` либо MS-DOS). */
function parseListLine(line) {
  // MS-DOS: "08-16-26  09:41PM       <DIR>          notifications"
  const dos = /^(\d{2}-\d{2}-\d{2,4})\s+(\d{2}:\d{2}(?:AM|PM)?)\s+(<DIR>|\d+)\s+(.+)$/i.exec(line);
  if (dos) {
    return {
      name: dos[4].trim(),
      isDirectory: dos[3].toUpperCase() === '<DIR>',
      size: dos[3].toUpperCase() === '<DIR>' ? 0 : Number(dos[3]),
      raw: line,
    };
  }
  // unix: "drwxr-xr-x 2 owner group 4096 Aug 16 20:54 notifications"
  const unix = /^([dl-])[rwxsStT-]{9}\+?\s+\S+\s+\S+\s+\S+\s+(\d+)\s+(?:\S+\s+\S+\s+\S+)\s+(.+)$/.exec(line);
  if (unix) {
    let name = unix[3].trim();
    if (unix[1] === 'l') name = name.split(' -> ')[0]; // симлинк
    return { name, isDirectory: unix[1] === 'd', size: Number(unix[2]), raw: line };
  }
  return null;
}

module.exports = { FtpClient, FtpError, parseListLine };
