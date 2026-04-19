# Minimal static web UI for the OpenMAIC content exporter.
# No build step — the image is just nginx:alpine + our HTML/JS/CSS.
#
# The official nginx:alpine entrypoint auto-runs envsubst on any files in
# /etc/nginx/templates/, producing /etc/nginx/conf.d/<name>.conf at container
# start. We rely on this so the compose-provided EXPORTER_AUTH_TOKEN +
# EXPORTER_BASE_URL get stamped into default.conf at boot.
#
# NGINX_ENVSUBST_FILTER is set in compose to "^EXPORTER_" so envsubst only
# touches our own env vars and leaves nginx runtime variables ($http_host,
# $uri, $host) alone.

FROM nginx:alpine

# Static assets
COPY public/ /usr/share/nginx/html/

# nginx config template — gets envsubst'd at container start into /etc/nginx/conf.d/default.conf.
# Removing the default.conf that ships with the image so our template is the only server block.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80
# Default CMD from the base image already launches nginx after template substitution.
