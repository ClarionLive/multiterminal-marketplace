#!/usr/bin/env node
/**
 * project-context-hook.js
 *
 * SessionStart hook that:
 *   1. Auto-installs the multiterminal plugin if not yet installed (once per project)
 *   2. Reads MULTITERMINAL_PROJECT_ID and injects project context
 *
 * Gracefully no-ops if MULTITERMINAL_PROJECT_ID is not set, if the API is
 * unreachable, or if the project is not found. Never blocks Claude.
 */
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Auto-install the multiterminal plugin if not already installed.
 * Uses a marker file to avoid running every session.
 * Runs silently — never blocks Claude on failure.
 */
function ensurePluginInstalled() {
  try {
    // Check for marker file in the project's .claude directory
    const cwd = process.env.CLAUDE_CWD || process.cwd();
    const markerDir = path.join(cwd, '.claude');
    const markerFile = path.join(markerDir, '.multiterminal-plugin-installed');

    if (fs.existsSync(markerFile)) return; // Already installed

    // Run plugin install (idempotent — safe if already installed)
    execSync('claude plugin install multiterminal@multiterminal-marketplace --scope project', {
      stdio: 'ignore',
      timeout: 10000,
      cwd: cwd
    });

    // Write marker so we don't run this again
    if (!fs.existsSync(markerDir)) fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(markerFile, new Date().toISOString());
  } catch (e) {
    // Silent failure — don't block Claude
  }
}

const API_PORT = 5050;
const API_TIMEOUT = 4000; // Project context fetch should be fast

/**
 * Fetch the project context from the REST API.
 * Returns the parsed JSON body or null on any error.
 */
function fetchProjectContext(projectId) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'localhost',
      port: API_PORT,
      path: `/api/projects/${encodeURIComponent(projectId)}/context`,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: API_TIMEOUT
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * Format the project context object into a human-readable string for Claude.
 */
function formatProjectContext(ctx) {
  const project = ctx.project || ctx.Project;
  if (!project) return null;

  const lines = [];

  // Header
  const projectName = project.name || project.Name || 'Unknown Project';
  const projectType = project.projectType || project.ProjectType || '';
  const description = project.description || project.Description || '';

  lines.push(`## Project Context: ${projectName}${projectType ? ` (${projectType})` : ''}`);
  if (description) {
    lines.push(description);
  }
  lines.push('');

  // Paths
  const sourcePath = project.sourcePath || project.SourcePath || project.path || project.Path;
  const deployPath = project.deployPath || project.DeployPath;
  const buildOutputPath = project.buildOutputPath || project.BuildOutputPath;

  const hasPaths = sourcePath || deployPath || buildOutputPath;
  const extraPaths = (ctx.paths || ctx.Paths || []);

  if (hasPaths || extraPaths.length > 0) {
    lines.push('### Paths');
    if (sourcePath) lines.push(`- Source: ${sourcePath}`);
    if (deployPath) lines.push(`- Deploy: ${deployPath}`);
    if (buildOutputPath) lines.push(`- Build Output: ${buildOutputPath}`);
    for (const p of extraPaths) {
      const pName = p.pathName || p.PathName || p.name || p.Name || 'Path';
      const pValue = p.pathValue || p.PathValue || p.value || p.Value || '';
      if (pValue) lines.push(`- ${pName}: ${pValue}`);
    }
    lines.push('');
  }

  // Commands
  const buildCommand = project.buildCommand || project.BuildCommand;
  const deployCommand = project.deployCommand || project.DeployCommand;
  const launchCommand = project.launchCommand || project.LaunchCommand;

  if (buildCommand || deployCommand || launchCommand) {
    lines.push('### Commands');
    if (buildCommand) lines.push(`- Build: \`${buildCommand}\``);
    if (deployCommand) lines.push(`- Deploy: \`${deployCommand}\``);
    if (launchCommand) lines.push(`- Launch: \`${launchCommand}\``);
    lines.push('');
  }

  // Git configuration
  const gitRepoUrl = project.gitRepoUrl || project.GitRepoUrl;
  const gitDefaultBranch = project.gitDefaultBranch || project.GitDefaultBranch;
  const gitAutoCommit = project.gitAutoCommit || project.GitAutoCommit;

  if (gitRepoUrl || gitDefaultBranch) {
    lines.push('### Git');
    if (gitRepoUrl) lines.push(`- Repo: ${gitRepoUrl}`);
    if (gitDefaultBranch) lines.push(`- Default Branch: ${gitDefaultBranch}`);
    if (gitAutoCommit) lines.push(`- Auto-commit: enabled`);
    lines.push('');
  }

  // Team agents
  const agents = ctx.agents || ctx.Agents || [];
  if (agents.length > 0) {
    lines.push('### Team Agents');
    for (const agent of agents) {
      const agentName = agent.agentName || agent.AgentName || agent.name || agent.Name || 'Agent';
      const agentRole = agent.role || agent.Role || '';
      const agentModel = agent.preferredModel || agent.PreferredModel || agent.model || agent.Model || '';
      let agentLine = `- ${agentName}`;
      if (agentRole) agentLine += ` (${agentRole})`;
      if (agentModel) agentLine += ` [${agentModel}]`;
      lines.push(agentLine);
    }
    lines.push('');
  }

  // MCP servers
  const mcpServers = ctx.mcpServers || ctx.McpServers || [];
  if (mcpServers.length > 0) {
    lines.push('### MCP Servers');
    for (const mcp of mcpServers) {
      const mcpName = mcp.serverName || mcp.ServerName || mcp.name || mcp.Name || 'MCP';
      const mcpUrl = mcp.serverUrl || mcp.ServerUrl || mcp.url || mcp.Url || '';
      let mcpLine = `- ${mcpName}`;
      if (mcpUrl) mcpLine += `: ${mcpUrl}`;
      lines.push(mcpLine);
    }
    lines.push('');
  }

  // Skills
  const skills = ctx.skills || ctx.Skills || [];
  if (skills.length > 0) {
    const skillNames = skills.map(s => s.skillName || s.SkillName || s.name || s.Name || '').filter(Boolean);
    if (skillNames.length > 0) {
      lines.push('### Skills');
      lines.push(skillNames.map(n => `- ${n}`).join('\n'));
      lines.push('');
    }
  }

  // Specialist agents
  const specialists = ctx.specialistAgents || ctx.SpecialistAgents || [];
  if (specialists.length > 0) {
    lines.push('### Specialist Agents');
    for (const spec of specialists) {
      const specType = spec.agentType || spec.AgentType || spec.type || spec.Type || 'Specialist';
      const specModel = spec.preferredModel || spec.PreferredModel || spec.model || spec.Model || '';
      let specLine = `- ${specType}`;
      if (specModel) specLine += ` [${specModel}]`;
      lines.push(specLine);
    }
    lines.push('');
  }

  // Version and changelog
  const currentVersion = project.currentVersion || project.CurrentVersion;
  if (currentVersion && currentVersion !== '0.1.0') {
    lines.push(`Current Version: ${currentVersion}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ── Core (dispatcher-callable) ───────────────────────────────────────
// Parses nothing from stdin (the CLI shim does that); takes the already-parsed
// hookData plus injectable side-effect deps (ensurePluginInstalled / fetch /
// env) so the SessionStart install+fetch path is unit-testable without a real
// `claude plugin install` spawn or a live REST call (ticket 42c91001). Returns
// {exitCode:0, stdout?} — stdout is the formatted project context (identical
// bytes to the prior console.log) or absent. SessionStart-only; other events
// no-op. SYNC dispatch head (context emitter; not a decision → accumulates).
async function run(hookData, deps = {}) {
  const _ensurePluginInstalled = deps.ensurePluginInstalled || ensurePluginInstalled;
  const _fetchProjectContext = deps.fetchProjectContext || fetchProjectContext;
  const env = deps.env || process.env;

  const hookType = hookData && (hookData.hook_type || hookData.type);

  // Only act on SessionStart
  if (hookType !== 'SessionStart') {
    return { exitCode: 0 };
  }

  // Auto-install plugin if needed (once per project, silent)
  _ensurePluginInstalled();

  // Check if a project ID is set in the environment
  const projectId = env.MULTITERMINAL_PROJECT_ID;
  if (!projectId) {
    // No project context for this session
    return { exitCode: 0 };
  }

  // Fetch context from REST API
  const ctx = await _fetchProjectContext(projectId);
  if (!ctx) {
    // API unreachable or project not found - continue silently
    return { exitCode: 0 };
  }

  // Format context for Claude (console.log appended a trailing newline)
  const formatted = formatProjectContext(ctx);
  if (formatted) {
    return { exitCode: 0, stdout: formatted + '\n' };
  }

  return { exitCode: 0 };
}

module.exports = { run };

// ── CLI shim (standalone invocation — preserves exact prior behavior) ─
if (require.main === module) {
  (async () => {
    // MT-ONLY (task c9285d2a). Registered on SessionStart with NO matcher, so it fires for every
    // start of every session. That is confined to MT terminals under --plugin-dir, but once the
    // plugin is installed at USER SCOPE it would inject MultiTerminal project context into every
    // Claude Code session on the machine — including projects MT does not manage.
    //
    // Guarded on the CLI entry only, so run() stays directly callable by tests.
    if (!process.env.MULTITERMINAL_NAME) {
      process.exit(0);
      return;
    }

    // Read hook input from stdin
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }

    // Parse hook type — malformed input no-ops before any side-effect
    let hookData;
    try {
      hookData = JSON.parse(input);
    } catch (e) {
      process.exit(0);
      return;
    }

    let out = { exitCode: 0 };
    try {
      out = await run(hookData, {});
    } catch (e) {
      out = { exitCode: 0 };
    }
    if (out && out.stdout) process.stdout.write(out.stdout);
    process.exit((out && out.exitCode) || 0);
  })().catch(() => {
    // Never block Claude on errors
    process.exit(0);
  });
}
