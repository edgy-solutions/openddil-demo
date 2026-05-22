#!/bin/sh
# Substitute nginx's DNS `resolver` with the real one from /etc/resolv.conf.
# nginx's `resolver` directive needs a literal IP and cannot read
# resolv.conf itself; the correct value differs by environment — Docker's
# embedded DNS is 127.0.0.11, k8s uses the cluster DNS. The nginx image
# runs every /docker-entrypoint.d/*.sh before launching nginx, so this
# rewrites the __DNS_RESOLVER__ placeholder in default.conf at start.
set -e
conf="/etc/nginx/conf.d/default.conf"
resolver="$(awk '/^nameserver/ { print $2; exit }' /etc/resolv.conf)"
sed -i "s/__DNS_RESOLVER__/${resolver:-127.0.0.11}/g" "$conf"
echo "40-resolver.sh: nginx resolver -> ${resolver:-127.0.0.11}"
