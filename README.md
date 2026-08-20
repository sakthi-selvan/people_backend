# People Backend

Express API for People HR, attendance, face kiosk, and payroll. Default port **4100**.

## Local development

```bash
cp .env.example .env
npm install
npm start
```

`npm run dev` is the same with `--watch`.

Seed logins (created on first start when `data/db.json` is empty):

| Role | Login | Password |
| --- | --- | --- |
| HR | `hr@people.local` | `Hr@123` |
| Employee | `employee@people.local` | `Employee@123` |
| Kiosk device | `Lobby Kiosk` | `Device@123` |

`admin@people.local` / `Admin@123` and `manager@people.local` / `Manager@123` are also seeded; the UI treats those roles as HR.

Data lives in `./data` (`db.json` and `uploads/`). That folder is gitignored.

Email defaults to Ethereal for MVP testing. Send a payslip or use **Test email** to get a preview URL.

---

## Docker (API image)

Build and run this service only:

```bash
docker build -t people-api:local .
docker run --rm -p 4100:4100 \
  -e JWT_SECRET=change-me \
  -e CORS_ORIGIN=http://localhost:5173 \
  -v people-data:/app/data \
  people-api:local
```

Health check: `GET /health` → `{ "status": "ok" }`.

Do not copy `.env` or `data/` into the image. Pass secrets with `-e` or Compose, and mount a volume for `/app/data`.

---

## Deploy on AWS EC2

The UI is a separate image (`people_frontend`). Nginx in that container proxies `/api` and `/uploads` to this API, so **only port 80** needs to be public. Keep 4100 off the security group.

Clone **both** repos as siblings (folder names must match):

```text
/opt/people/
  people_backend/
  people_frontend/
```

### 1. EC2 instance

- Ubuntu 22.04 or 24.04, 1 vCPU / 2 GB RAM is enough for this app.
- Security group inbound: **22** (your IP), **80** (0.0.0.0/0). Add **443** later if you terminate TLS.
- Elastic IP if you want a stable address.

### 2. Install Docker

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker ubuntu
# log out and back in so the docker group applies
```

### 3. Clone and configure

```bash
sudo mkdir -p /opt/people
sudo chown "$USER:$USER" /opt/people
cd /opt/people
git clone git@github.com:sakthi-selvan/people_backend.git
git clone git@github.com:sakthi-selvan/people_frontend.git

cd people_backend
cp deploy.env.example .env
# edit .env:
#   JWT_SECRET=$(openssl rand -hex 32)
#   CORS_ORIGIN=http://YOUR_EC2_PUBLIC_IP
#   HTTP_PORT=80
```

### 4. Start

From `people_backend` (Compose also builds `../people_frontend`):

```bash
cd /opt/people/people_backend
docker compose up -d --build
docker compose ps
curl -sS http://127.0.0.1/health
```

Open `http://YOUR_EC2_PUBLIC_IP` and sign in as HR.

You can run the same stack from `people_frontend` (`docker compose up -d --build` there uses `../people_backend`).

### 5. Operate

```bash
docker compose logs -f api web
docker compose restart
docker compose down          # stops containers; named volume people-data is kept
```

Back up attendance, faces, and payroll data:

```bash
docker run --rm -v people_people-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/people-data-$(date +%F).tar.gz -C /data .
```

Volume name may differ (`docker volume ls | grep people`). Restore by extracting into the same volume.

### HTTPS (optional)

Point a domain at the instance, then put Caddy or nginx on the host in front of `HTTP_PORT`, or change Compose to publish `127.0.0.1:8080:80` and reverse-proxy with Let's Encrypt.

Set `CORS_ORIGIN=https://your.domain` if you add TLS.

### SMTP (optional)

Fill `SMTP_*` in `.env` and `docker compose up -d` again. Empty SMTP keeps Ethereal test delivery.
