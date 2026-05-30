# Deploy guide

Two flavors: hobby (1 server, nginx + systemd) and serverless (Vercel for frontend, any VPS
for backend). Pick what you have.

## Hobby: 1 VPS, nginx + systemd

Assumes Ubuntu 22.04+ with Node 18+ installed.

### 1. Get a domain + DNS

Point an `A` record (e.g. `mytool.example.com`) at your VPS public IP.

### 2. Put the code on the server

```bash
ssh root@your-vps
sudo mkdir -p /opt/niche-blog-toolkit && sudo chown $USER /opt/niche-blog-toolkit
cd /opt/niche-blog-toolkit
git clone https://github.com/your-handle/niche-blog-toolkit .
```

### 3. Render the frontend

```bash
node scripts/apply-niche.js examples/plants   # or your own niche
sudo mkdir -p /var/www/niche-blog-toolkit
sudo cp frontend/dist/index.html /var/www/niche-blog-toolkit/
```

### 4. Configure the backend

```bash
cp backend/.env.example backend/.env
nano backend/.env
#   DEEPSEEK_API_KEY=sk-...
#   TAVILY_API_KEY=tvly-...           # optional
#   NICHE_CONFIG=../examples/plants/niche.json
#   ALLOWED_ORIGIN=https://mytool.example.com
#   SHARED_TOKEN=<same token you'll bake into apply-niche.js --token=...>
#   DAILY_CAP_USD=0.50
chmod 600 backend/.env
```

### 5. systemd unit

```ini
# /etc/systemd/system/niche-blog-toolkit.service
[Unit]
Description=niche-blog-toolkit backend
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/niche-blog-toolkit/backend
ExecStart=/usr/bin/node /opt/niche-blog-toolkit/backend/server.js
Restart=on-failure
RestartSec=3
User=root
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now niche-blog-toolkit
sudo systemctl status niche-blog-toolkit
```

### 6. nginx vhost

```nginx
# /etc/nginx/sites-available/niche-blog-toolkit
limit_req_zone $binary_remote_addr zone=nbtk_api:10m rate=20r/m;

server {
    listen 80;
    server_name mytool.example.com;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name mytool.example.com;

    ssl_certificate     /etc/letsencrypt/live/mytool.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mytool.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    root /var/www/niche-blog-toolkit;
    index index.html;

    location /api/ {
        limit_req zone=nbtk_api burst=5 nodelay;
        proxy_pass http://127.0.0.1:3007;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 40s;
        client_max_body_size 16k;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/niche-blog-toolkit /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 7. Let's Encrypt

```bash
sudo apt install -y certbot
sudo certbot certonly --webroot -w /var/www/certbot -d mytool.example.com
# then reload nginx:  sudo systemctl reload nginx
```

Auto-renewal is set up by certbot's systemd timer (`certbot.timer`). Verify with
`systemctl list-timers | grep certbot`.

### 8. Verify

```bash
curl -s https://mytool.example.com/api/health
# → {"ok":true,"niche":"plants","model":"deepseek-chat","spentUsd":0,...}
```

Open `https://mytool.example.com/` in your phone, fill in "Profile Packaging", press "✨ Свежая
идея от AI", and you should get a fresh, on-brand idea.

## Serverless flavor (Vercel for static + VPS for backend)

The frontend is just one HTML file — it doesn't need a Node runtime. Put `frontend/dist/index.html`
on Vercel/Cloudflare Pages/GitHub Pages and point `/api/` at a hosted backend (Render, Fly,
Railway, your VPS) via the `API_BASE` constant inside `<script>` or via a path rewrite.

Caveat: the backend has to live somewhere that can hold trend cache and (optionally) be
allowlisted by Tavily. Vercel/Cloudflare Functions cold-start adds latency — not the best fit.

## Cost ballpark (1 active blogger)

- DeepSeek: ~$0.001 per AI call. 100 calls/month = ~$0.10.
- Tavily: 1000 free searches/month. Cache 12h → ~60 calls/month = free.
- VPS: any €5/month box is plenty.

So: **~$5/month all-in** for one blogger's personal toolkit.
