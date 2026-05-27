#!/bin/sh
# Substitute environment-specific bits into nginx's default.conf at start.
# The nginx image runs every /docker-entrypoint.d/*.sh before launching
# nginx, so placeholders get rewritten in place before the master forks.
#
# Two placeholders:
#
#   __DNS_RESOLVER__  — IP for nginx's `resolver` directive. nginx can't
#                       read /etc/resolv.conf itself and the right value
#                       differs by environment: Docker's embedded DNS at
#                       127.0.0.11, k8s uses CoreDNS (typically 10.x).
#
#   __SVC_SUFFIX__    — suffix appended to bare upstream hostnames in
#                       `proxy_pass` variables (electric-sync, toxiproxy).
#                       nginx's `resolver` queries CoreDNS for the literal
#                       hostname and does NOT honor resolv.conf's `search`
#                       domains, so on k8s the bare name returns NXDOMAIN.
#                       Becomes `.<ns>.svc.cluster.local` on k8s, empty on
#                       compose (Docker's embedded DNS resolves bare names).
set -e
conf="/etc/nginx/conf.d/default.conf"

resolver="$(awk '/^nameserver/ { print $2; exit }' /etc/resolv.conf)"
sed -i "s/__DNS_RESOLVER__/${resolver:-127.0.0.11}/g" "$conf"
echo "40-resolver.sh: nginx resolver -> ${resolver:-127.0.0.11}"

# First search-list entry ending in svc.cluster.local is the namespaced
# k8s suffix. On compose, the search list has no such entry → empty suffix.
svc_suffix="$(awk '/^search/ {
    for (i = 2; i <= NF; i++) if ($i ~ /\.svc\.cluster\.local$/) { print "." $i; exit }
}' /etc/resolv.conf)"
sed -i "s/__SVC_SUFFIX__/${svc_suffix}/g" "$conf"
echo "40-resolver.sh: nginx svc suffix -> '${svc_suffix}'"
