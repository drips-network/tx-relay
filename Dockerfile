# Use an official Deno image.
FROM docker.io/denoland/deno:2.7.14

# Set the working directory in the container
WORKDIR /app
COPY . .

# Cache dependencies. Deno will use deno.json automatically.
# Copy deno.json first so this layer is cached if only source files change.
RUN deno cache main.ts --allow-import

# Expose the port the app runs on
EXPOSE 8000

# Command to run the application
# Deno uses deno.json automatically for import maps.
# Permissions are still needed.
CMD ["deno", "task", "start"]
