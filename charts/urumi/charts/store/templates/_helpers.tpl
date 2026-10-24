{{/* Labels every store object carries. NetworkPolicies and Services select Pods by "app". */}}
{{- define "store.labels" -}}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* The Secret holding store passwords: ours, or one the operator created (values-prod existingSecret). */}}
{{- define "store.secretName" -}}
{{- .Values.existingSecret | default (printf "%s-store" .Release.Name) -}}
{{- end }}
