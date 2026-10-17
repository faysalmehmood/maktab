# Self-hosted Maktab: quickstart

Full guide: [docs/self-host.md](../../docs/self-host.md). On the server (Docker + Compose, network `homelab`):

    sudo git clone https://github.com/faysalmehmood/maktab.git /srv/homelab/maktab/src
    sudo /srv/homelab/maktab/src/deploy/selfhost/install.sh gsap     # creates gsap/.env, builds, starts
    sudo nano /srv/homelab/maktab/gsap/.env                         # APP_ORIGIN, OWNER_EMAIL, Google, AGE_RECIPIENT
    cd /srv/homelab/maktab && sudo docker compose up -d --force-recreate   # apply the .env
    sudo docker logs -f maktab-gsap                                  # "database ok", "listening on"

Then route the tunnel's public hostname to `http://maktab-gsap:8787`. Upgrade: `git -C src pull`, re-run
`install.sh gsap`. Another school: `install.sh <name>` (container `maktab-<name>`).
