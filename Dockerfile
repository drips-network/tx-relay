FROM docker.io/denoland/deno:2.7.14
WORKDIR /app
COPY deno.json deno.lock ./
COPY drizzle ./drizzle
COPY src ./src
EXPOSE 8000
CMD ["deno", "task", "start"]
