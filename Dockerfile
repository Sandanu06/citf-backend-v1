# Use official Node.js LTS image
FROM node:18

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package.json ./

# Install dependencies
RUN npm install

# Copy backend code
COPY backend ./backend

# Expose port (default 5000)
EXPOSE 5000

# Start the server
CMD ["node", "backend/server.js"]
