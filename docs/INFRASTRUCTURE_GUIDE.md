# GrantFlow Infrastructure Guide (DigitalOcean, Nginx)

This runbook complements the Railway + Vercel production checklist. It walks through bootstrapping a DigitalOcean Droplet and configuring Nginx as a reverse proxy for self-hosted deployments. Use this guide when you need to self-host the backend (or an all-in-one stack) instead of Railway.

> **Prerequisites**
>
> - An already built GrantFlow bundle (`npm run build`) and/or the full repository
> - `backend/data/grantflow.db` seeded with the 11 baseline profiles (`npm run seed:db`, `npm run seed:profiles -- --force`, `npm run check:profiles`)
> - DigitalOcean account with the necessary permissions
> - SSH keys available on your workstation

> **Note:** For modern cloud deployments, we recommend using Vercel for frontend and Railway for backend. This guide is for self-hosted scenarios where you need more control over the infrastructure.

---

## 1. Provision a DigitalOcean Droplet

1. **Create droplet**
   - Choose the latest Ubuntu LTS image (22.04+).
   - Select a plan with at least 2 vCPUs / 4 GB RAM if you plan to run both backend and frontend. The backend alone runs comfortably on 1 vCPU / 1 GB if you host the frontend elsewhere.
   - Attach an SSH key for passwordless login.
2. **Enable backups** (optional but recommended).
3. **Firewalls**
   - Open ports `22`, `80`, `443`, and the API port you plan to expose (we’ll keep the Node app internal behind Nginx).
4. **Initial login**
   ```bash
   ssh root@<droplet_ip>
   adduser grantflow
   usermod -aG sudo grantflow
   rsync -av ~/.ssh/authorized_keys /home/grantflow/.ssh/
   chmod 700 /home/grantflow/.ssh
   chmod 600 /home/grantflow/.ssh/authorized_keys
   exit
   ssh grantflow@<droplet_ip>
   ```
5. **Install dependencies**
   ```bash
   sudo apt update && sudo apt upgrade -y
   sudo apt install -y build-essential git curl ufw sqlite3 nginx
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs
   ```
6. **Security baseline**
   ```bash
   sudo ufw allow OpenSSH
   sudo ufw allow 'Nginx Full'
   sudo ufw enable
   ```

---

## 2. Deploy GrantFlow on the Droplet

1. **Clone repository**
   ```bash
   git clone https://github.com/buckeye7066/grantflow.git
   cd grantflow
   npm install
   ```
2. **Seed SQLite**
   ```bash
   npm run seed:db
   npm run seed:profiles -- --force
   npm run check:profiles
   ```
3. **Build frontend**
   ```bash
   npm run build
   ```
4. **Create systemd unit for backend**
   ```bash
   sudo tee /etc/systemd/system/grantflow.service >/dev/null <<'EOF'
   [Unit]
   Description=GrantFlow API Server
   After=network.target

   [Service]
   Type=simple
   WorkingDirectory=/home/grantflow/grantflow
   Environment=NODE_ENV=production
   Environment=PORT=8080
   Environment=DATABASE_URL=/home/grantflow/grantflow/backend/data/grantflow.db
   Environment=ADMIN_TOKEN=<secure_random_value>
   Environment=OPENAI_API_KEY=<openai_key_if_needed>
   ExecStart=/usr/bin/node backend/server.js
   Restart=on-failure
   User=grantflow
   Group=grantflow

   [Install]
   WantedBy=multi-user.target
   EOF

   sudo systemctl daemon-reload
   sudo systemctl enable --now grantflow
   sudo systemctl status grantflow
   ```
5. **Serve frontend**
   - Option A: Let Vercel host the frontend (recommended). Set `VITE_API_URL` to the droplet URL.
   - Option B: Copy `dist/` to `/var/www/grantflow` and use Nginx to serve the static bundle.

---

## 3. Configure Nginx Reverse Proxy

Create an Nginx server block that proxies API requests to the Node process and (optionally) serves the Vite build:

```bash
sudo tee /etc/nginx/sites-available/grantflow >/dev/null <<'EOF'
server {
    listen 80;
    server_name api.axiombiolabs.org;

    location /api/ {
        proxy_pass http://127.0.0.1:8080/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /grantflow/ {
        alias /var/www/grantflow/;
        try_files $uri $uri/ /grantflow/index.html;
    }

    location /grantflow {
        return 302 /grantflow/;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/grantflow /etc/nginx/sites-enabled/grantflow
sudo nginx -t
sudo systemctl reload nginx
```

To enable HTTPS, use Let's Encrypt:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d api.axiombiolabs.org
```

This will automatically configure SSL and update the Nginx configuration.

---

## 4. Final Checks

1. **Backend health**
   ```bash
   curl https://api.axiombiolabs.org/api/health
   ```
2. **Profile audit**
   ```bash
   DB_PATH=/home/grantflow/grantflow/backend/data/grantflow.db npm run check:profiles
   ```
3. **Static bundle** (if served from droplet)
   ```bash
   curl -I https://api.axiombiolabs.org/grantflow/index.html
   ```
4. **Logs**
   ```bash
   sudo journalctl -u grantflow -f
   sudo tail -f /var/log/nginx/access.log
   ```
5. **TLS**
   - Confirm SSL certificate is valid.
   - Run [https://www.ssllabs.com/ssltest/](https://www.ssllabs.com/ssltest/) against `api.axiombiolabs.org` for a final sanity check.

---

## 5. Operational Tips

| Task | Command |
| --- | --- |
| Restart backend | `sudo systemctl restart grantflow` |
| Deploy new release | Pull latest Git commit, rebuild (`npm install`, `npm run build`), restart systemd service |
| Backup SQLite | `sqlite3 backend/data/grantflow.db ".backup '/home/grantflow/backups/grantflow-$(date +%F).db'"` |
| Rotate secrets | Update `/etc/systemd/system/grantflow.service`, run `sudo systemctl daemon-reload && sudo systemctl restart grantflow` |
| Nginx reload | `sudo nginx -t && sudo systemctl reload nginx` |

Keep this guide alongside the Railway/Vercel checklist so you can support both hosting models. Update it after each infrastructure change to keep future deployments predictable.
