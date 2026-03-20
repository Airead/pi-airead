# Code Review Agent Container
# Runs pi sub-agent in isolated environment for safe code analysis
#
# Supports both Docker and Apple Container runtimes:
#   Docker:           launched with --user 1000:1000, entrypoint passes through
#   Apple Container:  launched as root, entrypoint shadows .env then drops to node

FROM node:22-slim

# Install git (needed for code analysis) and setpriv (for privilege drop)
RUN apt-get update && apt-get install -y git util-linux && rm -rf /var/lib/apt/lists/*

# Install pi CLI globally
RUN npm install -g @mariozechner/pi-coding-agent

# Create workspace directories
RUN mkdir -p /workspace/repo /workspace/state /workspace/skills

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace /home/node

# Copy entrypoint script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# No USER directive — runtime determines the user:
#   Docker: --user 1000:1000 in container args
#   Apple Container: root initially, entrypoint drops to node after .env shadowing

# Working directory is the repo mount point
WORKDIR /workspace/repo

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
