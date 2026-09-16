#!/bin/sh
set -eu

# Nginx site configuration for slopcheck.tomtebo.org
cat << 'EOF' > /etc/nginx/sites-available/slopcheck.tomtebo.org
server {
    listen 80;
    listen [::]:80;
    server_name slopcheck.tomtebo.org;

    location / {
        proxy_pass http://127.0.0.1:8099;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

ln -sf /etc/nginx/sites-available/slopcheck.tomtebo.org /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx

# Request TLS certificate via Certbot if installed
if command -v certbot >/dev/null 2>&1; then
    certbot --nginx -d slopcheck.tomtebo.org --non-interactive --agree-tos --redirect
fi
