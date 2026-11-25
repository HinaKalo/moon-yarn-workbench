FROM mcr.microsoft.com/dotnet/sdk:10.0 AS dotnet-build
WORKDIR /work
COPY runner/YarnPreview.csproj ./
RUN dotnet restore -r linux-x64
COPY runner/Program.cs ./
RUN dotnet publish --no-restore --self-contained -r linux-x64 -c Release -o /preview

FROM docker.io/library/node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production BIND_HOST=0.0.0.0 PORT=18849 SCRIPT_DIR=/data DOTNET_EnableDiagnostics=0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=dotnet-build /preview ./runner
COPY server.mjs sso.mjs login-page.mjs demo.mjs stdio.mjs ./
COPY public ./public
USER 1000:1000
EXPOSE 18849
CMD ["node", "server.mjs"]
