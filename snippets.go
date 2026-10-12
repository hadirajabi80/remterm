package main

// Built-in snippet catalog. Placeholders: {{name}} or {{name:default}};
// the UI asks for them before sending and remembers the last value.
// Docker/Go template syntax such as {{.Names}} or {{json .State}} is left
// alone because placeholder names must start with a letter and contain no
// spaces.

// Bump when the catalog changes so existing installs merge in new entries.
const snippetCatalogVersion = 2

type catalogEntry struct{ group, name, command, desc string }

var snippetCatalog = []catalogEntry{
	// ---- .NET ----
	{".NET", "SDKs & runtimes", `dotnet --info`,
		"Shows installed .NET SDKs and runtimes. Check the server has the runtime your app targets (e.g. Microsoft.AspNetCore.App 8.x)."},
	{".NET", "Build (Release)", `dotnet build -c Release`,
		"Restores NuGet packages and compiles the project/solution in the current folder with Release optimizations."},
	{".NET", "Publish", `dotnet publish -c Release -o {{out:./publish}}`,
		"Produces a framework-dependent deployment folder. Copy it to the server and run it with `dotnet App.dll` or a systemd unit."},
	{".NET", "Publish self-contained (linux-x64)", `dotnet publish -c Release -r linux-x64 --self-contained true -p:PublishSingleFile=true -o {{out:./publish}}`,
		"Single executable that bundles the .NET runtime — the server does not need .NET installed. Larger output, no runtime version issues."},
	{".NET", "Run in Production", `ASPNETCORE_ENVIRONMENT=Production ASPNETCORE_URLS=http://0.0.0.0:{{port:5000}} dotnet {{dll:MyApi.dll}}`,
		"Starts the app in the foreground with production settings (appsettings.Production.json) listening on all interfaces. Good for a quick smoke test before wiring up systemd."},
	{".NET", "Run tests", `dotnet test --logger "console;verbosity=normal"`,
		"Builds and runs all test projects, printing each test result instead of only the summary."},
	{".NET", "EF Core: apply migrations", `dotnet ef database update`,
		"Applies pending Entity Framework Core migrations to the database from the connection string in appsettings. Needs the dotnet-ef tool."},
	{".NET", "EF Core: install dotnet-ef", `dotnet tool install --global dotnet-ef`,
		"Installs the EF Core CLI (dotnet ef). Add ~/.dotnet/tools to PATH if the command is not found afterwards."},
	{".NET", "Restart API service", `sudo systemctl restart {{service:myapi}} && journalctl -u {{service:myapi}} -n 50 --no-pager`,
		"Restarts the systemd unit that hosts your ASP.NET Core app and prints its last 50 log lines so you can see it started cleanly."},
	{".NET", "Live metrics (dotnet-counters)", `dotnet-counters monitor -n {{process:MyApi}}`,
		"Live CPU, GC heap, thread pool and request-rate counters of a running .NET process. Install with: dotnet tool install -g dotnet-counters."},
	{".NET", "Clear NuGet caches", `dotnet nuget locals all --clear`,
		"Deletes all local NuGet caches. Fixes most 'package restore' oddities and frees disk space; the next restore downloads again."},

	// ---- Docker ----
	{"Docker", "Running containers", `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'`,
		"Compact table of running containers with image, uptime/health and published ports."},
	{"Docker", "All containers (incl. stopped)", `docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'`,
		"Also lists exited containers — useful to spot crashed ones (Status shows the exit code)."},
	{"Docker", "Follow container logs", `docker logs -f --tail 200 {{container}}`,
		"Streams a container's stdout/stderr, starting with the last 200 lines. Ctrl+C stops following, not the container."},
	{"Docker", "Shell into container", `docker exec -it {{container}} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`,
		"Opens an interactive shell inside a running container — bash if the image has it, otherwise sh (Alpine)."},
	{"Docker", "Restart container", `docker restart {{container}}`,
		"Stops and starts the container again, keeping its configuration and volumes."},
	{"Docker", "Resource usage", `docker stats --no-stream`,
		"One-shot snapshot of CPU, memory, network and disk I/O per container."},
	{"Docker", "Container ports & IP", `docker inspect {{container}} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}{{json .NetworkSettings.Ports}}'`,
		"Shows the container's internal IP address(es) and how its ports are mapped to the host."},
	{"Docker", "Build image", `docker build -t {{image:myapp}}:{{tag:latest}} .`,
		"Builds an image from the Dockerfile in the current folder and tags it name:tag."},
	{"Docker", "Run container (detached)", `docker run -d --name {{container}} -p {{port:8080}}:{{containerPort:8080}} --restart unless-stopped {{image:myapp}}:{{tag:latest}}`,
		"Starts a container in the background, publishes a port, and restarts it automatically after crashes or reboots."},
	{"Docker", "Disk usage", `docker system df`,
		"How much disk images, containers, volumes and build cache use, and how much is reclaimable."},
	{"Docker", "Clean up unused data", `docker system prune -f`,
		"Removes stopped containers, unused networks, dangling images and build cache WITHOUT asking. Volumes are kept."},

	// ---- Docker Compose ----
	{"Docker Compose", "Up (rebuild)", `docker compose up -d --build`,
		"Builds images that changed and (re)creates containers in the background for the compose.yaml in the current folder."},
	{"Docker Compose", "Status", `docker compose ps`,
		"State, health and ports of every service in this compose project."},
	{"Docker Compose", "Follow logs", `docker compose logs -f --tail=200 {{service:}}`,
		"Streams logs of all services, or only one if you enter a service name."},
	{"Docker Compose", "Restart service", `docker compose restart {{service}}`,
		"Restarts one service's containers without recreating them (config changes in compose.yaml are NOT applied — use Up for that)."},
	{"Docker Compose", "Pull & redeploy", `docker compose pull && docker compose up -d && docker image prune -f`,
		"Typical update: download newer images, recreate only containers whose image changed, then delete the old dangling images."},
	{"Docker Compose", "Down", `docker compose down`,
		"Stops and removes the project's containers and networks. Named volumes (your data) are kept unless you add -v."},

	// ---- Node.js ----
	{"Node.js", "Versions", `node -v && npm -v`,
		"Node and npm versions on this server — compare with your local machine / .nvmrc when builds behave differently."},
	{"Node.js", "Use project Node version (nvm)", `nvm install && nvm use`,
		"Installs and switches to the Node version pinned in .nvmrc. Requires nvm."},
	{"Node.js", "Clean install (CI)", `npm ci`,
		"Exact, reproducible install from package-lock.json; deletes node_modules first. Fails if the lockfile is out of sync — preferred on servers."},
	{"Node.js", "Install production deps only", `npm ci --omit=dev`,
		"Same as npm ci but skips devDependencies — smaller node_modules for running (not building) an app."},
	{"Node.js", "Outdated packages", `npm outdated`,
		"Lists dependencies with newer versions available: Current, Wanted (allowed by package.json) and Latest."},
	{"Node.js", "Security audit", `npm audit --omit=dev`,
		"Checks production dependencies against the npm advisory database."},

	// ---- PM2 ----
	{"PM2", "Status", `pm2 status`,
		"All Node processes managed by PM2 with uptime, restarts, CPU and memory."},
	{"PM2", "Start app", `pm2 start {{script:dist/main.js}} --name {{app}}`,
		"Runs a Node app under PM2 so it restarts on crash. Use dist/main.js for NestJS or server.js for Express."},
	{"PM2", "Reload (zero downtime)", `pm2 reload {{app}}`,
		"Restarts the app's processes one by one so requests keep being served (cluster mode); falls back to restart otherwise."},
	{"PM2", "Logs", `pm2 logs {{app:}} --lines 200`,
		"Streams logs of all apps, or one app if you enter its name."},
	{"PM2", "Live monitor", `pm2 monit`,
		"Full-screen dashboard with per-process CPU/memory and live logs. Press q to quit."},
	{"PM2", "Start on boot", `pm2 save && pm2 startup`,
		"Saves the current process list and prints the sudo command that registers PM2 with systemd — run that printed command next."},

	// ---- Angular ----
	{"Angular", "Production build", `npx ng build --configuration production`,
		"Optimized build. Angular 17+ writes to dist/<project>/browser, older versions to dist/<project>."},
	{"Angular", "Deploy build to nginx", `sudo rsync -a --delete dist/{{project}}/browser/ /var/www/{{site}}/ && sudo systemctl reload nginx`,
		"Copies the build into the web root, removing files from the previous build, then reloads nginx. Drop /browser for Angular 16 and older."},
	{"Angular", "Dev server (reachable remotely)", `npx ng serve --host 0.0.0.0 --port {{port:4200}}`,
		"Runs the dev server on all interfaces. Prefer an SSH tunnel over opening the port in the firewall."},
	{"Angular", "Versions", `npx ng version`,
		"Angular CLI, framework packages, Node and TypeScript versions of this project."},
	{"Angular", "Update Angular", `npx ng update @angular/core @angular/cli`,
		"Upgrades Angular one major version and runs the code migrations. Commit first so you can review the changes."},
	{"Angular", "Largest bundles", `ls -lhS dist/{{project}}/browser/*.js | head`,
		"Biggest JavaScript chunks of the last build — a quick check after adding a heavy dependency."},

	// ---- React ----
	{"React", "Production build", `npm run build`,
		"Runs the project's build script. Vite writes to dist/, Create React App to build/, Next.js to .next/."},
	{"React", "Deploy Vite build to nginx", `sudo rsync -a --delete dist/ /var/www/{{site}}/ && sudo systemctl reload nginx`,
		"Copies a Vite build into the web root (use build/ instead of dist/ for CRA) and reloads nginx."},
	{"React", "Preview production build", `npx vite preview --host 0.0.0.0 --port {{port:4173}}`,
		"Serves the built dist/ folder locally to check the production bundle before deploying."},
	{"React", "Next.js: build & start", `npm run build && npx next start -p {{port:3000}}`,
		"Builds the Next.js app and starts the production server in the foreground."},
	{"React", "Next.js: run with PM2", `pm2 start npm --name {{app}} -- start`,
		"Keeps `npm start` (next start) running under PM2 with automatic restarts."},

	// ---- Nginx ----
	{"Nginx", "Test & reload", `sudo nginx -t && sudo systemctl reload nginx`,
		"Validates the configuration first and only reloads if it is valid — no downtime and no broken config going live."},
	{"Nginx", "Enabled sites", `ls -l /etc/nginx/sites-enabled/`,
		"Which site configs are active (symlinks into sites-available)."},
	{"Nginx", "Error log", `sudo tail -f -n 100 /var/log/nginx/error.log`,
		"Follows the nginx error log — first place to look for 502/504 errors from your API upstream."},
	{"Nginx", "Access log", `sudo tail -f -n 100 /var/log/nginx/access.log`,
		"Follows incoming requests with status codes."},
	{"Nginx", "HTTPS certificate (certbot)", `sudo certbot --nginx -d {{domain}}`,
		"Obtains a Let's Encrypt certificate for the domain and updates the nginx config for HTTPS. Renewal is automatic."},
	{"Nginx", "Certificate expiry", `sudo certbot certificates`,
		"Lists certificates managed by certbot with their domains and expiry dates."},

	// ---- systemd services ----
	{"Services", "Status", `systemctl status {{service}} --no-pager`,
		"Whether a systemd service is running, since when, its main PID and the last log lines."},
	{"Services", "Follow service logs", `journalctl -u {{service}} -f -n 200`,
		"Streams a service's logs (stdout of your .NET / Node / Go app when run by systemd)."},
	{"Services", "Errors since boot", `journalctl -u {{service}} -p err -b --no-pager`,
		"Only error-level log entries of a service since the last reboot."},
	{"Services", "Failed units", `systemctl --failed`,
		"All services that failed to start or crashed."},

	// ---- System ----
	{"System", "Disk usage", `df -h`,
		"Used and free space of every mounted filesystem."},
	{"System", "Largest folders here", `du -h --max-depth=1 . 2>/dev/null | sort -hr | head -20`,
		"The 20 biggest directories under the current folder — find what filled the disk."},
	{"System", "Memory", `free -h`,
		"RAM and swap usage. 'available' is what apps can still use."},
	{"System", "Top processes (CPU)", `ps aux --sort=-%cpu | head -15`,
		"Processes using the most CPU right now."},
	{"System", "Top processes (memory)", `ps aux --sort=-%mem | head -15`,
		"Processes using the most memory."},
	{"System", "Listening ports", `sudo ss -tulpn`,
		"Every TCP/UDP port the server listens on and the process that owns it."},
	{"System", "Who uses a port", `sudo lsof -i :{{port:8080}}`,
		"Finds the process bound to a port — typical fix for 'address already in use'."},
	{"System", "System info", `hostnamectl; uptime`,
		"OS version, kernel, hostname, uptime and load averages."},

	// ---- Git ----
	{"Git", "Status", `git status -sb`,
		"Short status with the current branch and how far it is ahead/behind the remote."},
	{"Git", "Pull (fast-forward only)", `git pull --ff-only`,
		"Updates the checkout without creating merge commits; refuses if the server copy has diverged."},
	{"Git", "Recent commits", `git log --oneline --graph -15`,
		"Last 15 commits as a compact graph — check what is deployed."},

	// ---- Go ----
	{"Go", "Build & run", `go build -o app . && ./app`,
		"Compiles the package in the current folder and runs the binary."},
	{"Go", "Build small binary", `CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o {{bin:app}} .`,
		"Static, stripped binary — easy to copy between Linux servers."},
	{"Go", "Run tests", `go test ./...`,
		"Runs all tests in the module."},
}

func defaultSnippets() []Snippet {
	out := make([]Snippet, 0, len(snippetCatalog))
	for _, e := range snippetCatalog {
		out = append(out, Snippet{ID: newID(), Group: e.group, Name: e.name, Command: e.command, Description: e.desc})
	}
	return out
}

// v1Defaults are the snippets shipped before the catalog had descriptions.
// Untouched copies are replaced by the new catalog; edited ones are kept.
var v1Defaults = map[[2]string]string{
	{"System", "Disk usage"}:          "df -h",
	{"System", "Memory"}:              "free -h",
	{"System", "Top processes (CPU)"}: "ps aux --sort=-%cpu | head -15",
	{"System", "Listening ports"}:     "sudo ss -tulpn",
	{"Docker", "Containers"}:          "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'",
	{"Docker", "Compose up"}:          "docker compose up -d",
	{"Docker", "Compose logs"}:        "docker compose logs -f --tail=200",
	{".NET", "Restart service"}:       "sudo systemctl restart myapi && systemctl status myapi --no-pager",
	{".NET", "Service logs"}:          "journalctl -fu myapi",
	{"Node", "PM2 status"}:            "pm2 status",
	{"Node", "PM2 logs"}:              "pm2 logs --lines 200",
	{"Nginx", "Test & reload"}:        "sudo nginx -t && sudo systemctl reload nginx",
	{"Go", "Build & run"}:             "go build -o app . && ./app",
}

// upgradeSnippets merges the current catalog into an existing list: unedited
// old defaults are dropped, user snippets stay, and catalog entries that are
// missing (by group + name) are appended.
func upgradeSnippets(existing []Snippet) []Snippet {
	have := map[[2]string]bool{}
	var out []Snippet
	for _, s := range existing {
		key := [2]string{s.Group, s.Name}
		if cmd, ok := v1Defaults[key]; ok && cmd == s.Command && s.Description == "" {
			continue
		}
		have[key] = true
		out = append(out, s)
	}
	for _, s := range defaultSnippets() {
		if !have[[2]string{s.Group, s.Name}] {
			out = append(out, s)
		}
	}
	return out
}
