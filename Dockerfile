FROM node:22-alpine

# Install necessary system dependencies (ffmpeg/ffprobe for media processing, libc compatibility)
RUN apk add --no-cache ffmpeg ffprobe libc6-compat gcompat

WORKDIR /app

# Copy package manifests first for optimal layer caching
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy application source code
COPY . .

# Support HOST and PORT environment variables (default HOST to 0.0.0.0 for container networking)
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "run", "dev"]
