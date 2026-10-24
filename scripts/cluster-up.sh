#!/usr/bin/env bash
# Create the local k3d cluster. k3d runs k3s (the same distro we use on the VPS) inside Docker.
set -euo pipefail

CLUSTER=urumi

if k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  echo "cluster '$CLUSTER' already exists"
  exit 0
fi

# --port 80:80@loadbalancer  → laptop port 80 goes to k3d's load balancer, which forwards to Traefik
#                               (k3s's built-in ingress controller). That's how *.localtest.me reaches Ingress rules.
# --agents 0                  → a single node (the server) is enough locally.
k3d cluster create "$CLUSTER" \
  --agents 0 \
  --port "80:80@loadbalancer" \
  --port "443:443@loadbalancer" \
  --wait

kubectl config use-context "k3d-$CLUSTER"
kubectl get nodes
