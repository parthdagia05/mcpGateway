# Everyday commands. Every kubectl/helm call names the k3d cluster explicitly, because this laptop
# also has other clusters (docker-desktop, kind, minikube) and we must never deploy into those by accident.

CONTEXT := k3d-urumi
NS      := urumi
CHART   := charts/urumi
VALUES  := $(CHART)/values-local.yaml
KUBECTL := kubectl --context $(CONTEXT) -n $(NS)
HELM    := helm --kube-context $(CONTEXT) -n $(NS)

WOO_MCP_IMAGE    := urumi/woo-mcp:0.2.0
EVERYTHING_IMAGE := urumi/everything-mcp:2.0.0
GATEWAY_IMAGE    := urumi/gateway:0.3.1
DASHBOARD_IMAGE  := urumi/dashboard:0.1.1

.PHONY: cluster images deploy status admin-password gateway-admin-password setup-logs woo-mcp-forward uninstall

cluster:          ## create the local k3d cluster (safe to rerun)
	./scripts/cluster-up.sh

images:           ## build our images and load them into k3d (no registry needed locally)
	docker build -t $(WOO_MCP_IMAGE) services/woo-mcp
	docker build -t $(EVERYTHING_IMAGE) services/everything
	docker build -t $(GATEWAY_IMAGE) services/gateway
	docker build -t $(DASHBOARD_IMAGE) services/dashboard
	k3d image import $(WOO_MCP_IMAGE) $(EVERYTHING_IMAGE) $(GATEWAY_IMAGE) $(DASHBOARD_IMAGE) -c urumi

woo-mcp-forward:  ## debug only: expose woo-mcp on localhost:3300 for MCP Inspector (needs cluster admin access)
	$(KUBECTL) port-forward svc/urumi-woo-mcp 3300:3000

deploy:           ## install or upgrade everything (waits for the store setup Job)
	$(HELM) upgrade --install urumi $(CHART) --create-namespace -f $(VALUES) --timeout 15m

status:           ## what's running
	$(KUBECTL) get pods,svc,ingress,pvc,jobs

admin-password:   ## WordPress admin password (user: admin) for http://store.localtest.me/wp-admin
	@$(KUBECTL) get secret urumi-store -o jsonpath='{.data.wp-admin-password}' | base64 -d; echo

gateway-admin-password:  ## dashboard login for admin@urumi.local at http://dashboard.localtest.me
	@$(KUBECTL) get secret urumi-gateway -o jsonpath='{.data.bootstrap-admin-password}' | base64 -d; echo

setup-logs:       ## what the last store setup run did
	$(KUBECTL) logs job/urumi-store-setup

uninstall:        ## remove the release (PVCs and the passwords Secret are kept on purpose)
	$(HELM) uninstall urumi
