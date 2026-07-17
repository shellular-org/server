# NOT a non-interactive script.
# more like a guide/checklist for setting up a new server.

# home
cd ~

# install shit
sudo apt install curl gnupg2 ca-certificates lsb-release ubuntu-keyring

sudo apt update

sudo apt install -y curl nginx certbot python3-certbot-nginx

# enable nginx
sudo systemctl enable --now nginx

# install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash

# load nvm
source ~/.bashrc

# install node
nvm install --lts

# update npm to latest version
npm install -g npm@latest

# clone shellular server wherever we want - (ideally the dir named to domain, e.g. api.shellular.dev)
git clone https://github.com/shellular-org/server <directory.name>

# cd into the cloned repo

# create .env file from example
cp .env.example .env

# populate .env file with values (see .env.example for reference)
# make sure NODE_ENV=prod

# install dependencies
pnpm i

# install pm2 globally
npm i -g pm2

# start the server using script from package.json
## if relay, then run
pnpm run relay:pm2:start

# if central server, then run
pnpm run central:pm2:start


# set up nginx config
## default nginx config is in deploy/nginx/default.conf
## use that to replace the default nginx config in /etc/nginx/sites-available/default
cd /etc/nginx/sites-available
truncate --size=0 default
nano default

# generate SSL certificate using certbot
sudo certbot certonly --nginx -d <domain>

# now use template nginx config in deploy/nginx/shellular.conf to create a new nginx config for the server
cd /etc/nginx/sites-available/
nano <domain>

# save it and create a symlink to sites-enabled
sudo ln -s /etc/nginx/sites-available/<domain> \
           /etc/nginx/sites-enabled/



# now test nginx config and reload nginx
sudo nginx -t
sudo systemctl reload nginx

