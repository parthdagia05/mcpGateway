# Everyday commands. Every kubectl/helm call names the k3d cluster explicitly, because this laptop
# also has other clusters (docker-desktop, kind, minikube) and we must never deploy into those by accident.

CONTEXT := k3d-urumi
NS      := urumi
CHART   := charts/urumi
VALUES  := $(CHART)/values-local.yaml
KUBECTL := kubectl --context $(CONTEXT) -n $(NS)
HELM    := helm --kube-context $(CONTEXT) -n $(NS)

.PHONY: cluster deploy status admin-password setup-logs uninstall

cluster:          ## create the local k3d cluster (safe to rerun)
	./scripts/cluster-up.sh

deploy:           ## install or upgrade everything (waits for the store setup Job)
	$(HELM) upgrade --install urumi $(CHART) --create-namespace -f $(VALUES) --timeout 15m

status:           ## what's running
	$(KUBECTL) get pods,svc,ingress,pvc,jobs

admin-password:   ## WordPress admin password (user: admin) for http://store.localtest.me/wp-admin
	@$(KUBECTL) get secret urumi-store -o jsonpath='{.data.wp-admin-password}' | base64 -d; echo

setup-logs:       ## what the last store setup run did
	$(KUBECTL) logs job/urumi-store-setup

uninstall:        ## remove the release (PVCs and the passwords Secret are kept on purpose)
	$(HELM) uninstall urumi
