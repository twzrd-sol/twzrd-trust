FROM python:3.12-slim

WORKDIR /app

# Install the twzrd-agent-intel package
COPY . /app
RUN pip install -e .

# MCP server entry point (stdio by default, use --sse for HTTP)
CMD ["python", "-m", "twzrd_agent_intel.mcp.server"]

# For SSE mode override:
# CMD ["python", "-m", "twzrd_agent_intel.mcp.server", "--sse", "--host", "0.0.0.0", "--port", "8002"]
