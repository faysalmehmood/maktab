# Self-hosted Maktab: quickstart

Full guide: [docs/self-host.md](../../docs/self-host.md). As the homelab user (uid 1000, in the `docker`
group; no sudo), with Docker + Compose and the external network `homelab`:

    git clone https://github.com/faysalmehmood/maktab.git /srv/homelab/maktab/src
    /srv/homelab/maktab/src/deploy/selfhost/install.sh gsap   # 1st run: creates gsap/.env and stops
    nano /srv/homelab/maktab/gsap/.env                       # APP_ORIGIN, OWNER_EMAIL, Google, AGE_RECIPIENT
    /srv/homelab/maktab/src/deploy/selfhost/install.sh gsap   # builds, starts, prints /healthz

Then route the tunnel's public hostname to `http://maktab-gsap:8787` and set up the off-site copy
(docs/self-host.md §7.2, required). Upgrade: `git -C src pull` and re-run `install.sh gsap` (rollback:
§6). Another school: `install.sh <name>` (container `maktab-<name>`).
