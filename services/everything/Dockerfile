# The official MCP reference server ("everything"), packaged as an in-cluster upstream for the gateway.
# We don't write this one ourselves: it's a third-party server, installed from npm at a pinned version.
# Useful demo tools: get-sum and echo (harmless), trigger-long-running-operation (slow, for timeout demos),
# and get-env (prints its own environment: a reminder that upstreams are untrusted code, so this Pod gets no Secrets).
FROM node:24-alpine
RUN npm install -g @modelcontextprotocol/server-everything@2.0.0 && npm cache clean --force
USER node
ENV PORT=3001
EXPOSE 3001
CMD ["mcp-server-everything", "streamableHttp"]
