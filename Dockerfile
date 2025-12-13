# Build stage
FROM node:20-alpine AS build

WORKDIR /app

# Copy package.json and package-lock.json first to leverage Docker cache
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY . .

# Build TypeScript to /app/dist
RUN npm run build


# Runtime stage
FROM node:20-alpine AS runtime

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --production

# Ensure fontconfig and a default TrueType font are installed so SVG text renders correctly
# when running in the minimal Alpine container. This prevents missing-glyph squares due to
# absent fonts (ASCII and extended characters).
RUN apk add --no-cache fontconfig ttf-dejavu ttf-freefont
RUN fc-cache -f -v || true

# Copy built files from build stage
COPY --from=build /app/dist ./dist

# Ensure there is a /config folder that can be bind-mounted by the host
RUN mkdir -p /config

# Default command: start the compiled JS and load config from /config/config.yaml
CMD ["node", "dist/index.js", "/config/config.yaml"]
