FROM node:22-bookworm-slim

# Install system dependencies (ffmpeg/ffprobe for media processing, git, curl, ca-certificates, procps)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    git \
    curl \
    ca-certificates \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests first for dependency installation
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Support HOST and PORT environment variables (default HOST to 0.0.0.0 for container networking)
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

# Mount local folder into /app volume at runtime:
# docker run -p 3000:3000 -v $(pwd):/app -v /app/node_modules --env-file .env.local gondola
CMD ["npm", "run", "dev"]
