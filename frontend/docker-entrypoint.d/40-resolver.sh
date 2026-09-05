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

# __ELECTRIC_UPSTREAM__ / __ELECTRIC_PORT__ / __PEP_UPSTREAM__
#
# Where the read path goes. Electric directly when releasability enforcement
# is off; the PEP when it is on. Defaults keep the pre-enforcement behaviour
# for any deployment that sets nothing, so this change is inert until a chart
# opts in.
#
# THE DEFAULT IS THE UNENFORCED PATH, AND THAT IS THE RIGHT WAY ROUND ONLY
# BECAUSE THE NETWORKPOLICY IS THE REAL GATE. If enforcement is on and this
# is left pointing at Electric, Electric refuses the connection and the
# screen breaks visibly — rather than serving every nation's rows to
# everyone, which is what a silent fallback would do.
electric_upstream="${OPENDDIL_ELECTRIC_UPSTREAM:-electric-sync}"
electric_port="${OPENDDIL_ELECTRIC_PORT:-5133}"
pep_upstream="${OPENDDIL_PEP_UPSTREAM:-openddil-pep}"
sed -i "s/__ELECTRIC_UPSTREAM__/${electric_upstream}/g" "$conf"
sed -i "s/__ELECTRIC_PORT__/${electric_port}/g" "$conf"
sed -i "s/__PEP_UPSTREAM__/${pep_upstream}/g" "$conf"
echo "40-resolver.sh: read path -> ${electric_upstream}:${electric_port}"
echo "40-resolver.sh: auth path -> ${pep_upstream}:8080"

# A placeholder that survives substitution becomes a hostname nginx cannot
# resolve, and the failure surfaces as a 502 on the first request rather
# than at start-up. Fail here instead, where the message can say which one.
if grep -q "__[A-Z_]*__" "$conf"; then
    echo "40-resolver.sh: FATAL — unsubstituted placeholder(s):" >&2
    grep -o "__[A-Z_]*__" "$conf" | sort -u >&2
    exit 1
fi
