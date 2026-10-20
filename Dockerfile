# Build from the project root. No speech credentials or original candidate documents are copied.
FROM node:24-bookworm-slim
ENV NODE_ENV=production APP_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --chown=node:node web-voice-agent/package.json ./web-voice-agent/package.json
COPY --chown=node:node web-voice-agent/server ./web-voice-agent/server
COPY --chown=node:node web-voice-agent/public ./web-voice-agent/public
COPY --chown=node:node web-voice-agent/config ./web-voice-agent/config
COPY --chown=node:node knowledge_base/records.json knowledge_base/qa-core.json knowledge_base/qa-expanded.json knowledge_base/qa-rice-2026-10.json knowledge_base/verified_sources.json knowledge_base/project_sources.json ./knowledge_base/
RUN mkdir -p /app/web-voice-agent/data && chown node:node /app/web-voice-agent/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "web-voice-agent/server/index.js"]
