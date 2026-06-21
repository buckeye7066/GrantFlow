# GrantFlow self-hosted web search ("our own Brave").
#
# Wraps the official SearXNG image and bakes in a JSON-enabled config so the
# GrantFlow backend (backend/services/crawlers/searxngProvider.js) can call
# `?format=json`. Deploy as its own Railway service and point SEARXNG_URL at it.
# See docs/SEARXNG_SELF_HOST.md for the full runbook.
FROM searxng/searxng:latest

# Ship our JSON-enabled settings. SEARXNG_SECRET / INSTANCE_NAME come from the
# Railway service environment and override values here at runtime.
COPY settings.yml /etc/searxng/settings.yml
ENV SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml

EXPOSE 8080
