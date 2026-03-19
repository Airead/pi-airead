# Code Review Agent Container
# Runs pi sub-agent in isolated environment for safe code analysis

FROM node:22-slim

# Install git (needed for code analysis, no Chromium needed)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Install pi CLI globally
RUN npm install -g @mariozechner/pi-coding-agent

# Create workspace directories
RUN mkdir -p /workspace/repo /workspace/state /workspace/skills

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace /home/node

# Switch to non-root user
USER node

# Working directory is the repo mount point
WORKDIR /workspace/repo

# No ENTRYPOINT — host specifies the command via docker args
