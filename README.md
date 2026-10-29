# codearchaeologist-ai
An autonomous AI agent that reconstructs undocumented business logic in legacy software and verifies its discoveries through executable tests. Built for the Meta Global AI Developer Hackathon 2026.


# 🏛️ CodeArchaeologist AI

**Reconstructing the hidden intelligence of legacy software.**

CodeArchaeologist AI is an autonomous, AI-powered software investigation platform designed to uncover undocumented business logic, reconstruct application behavior, and verify discoveries through executable tests.

Built for the **Meta Global AI Developer Hackathon 2026**.

## Application routes

- `/` — Repository Intelligence: scan a local directory, import graph JSON, or analyze a public GitHub repository when the isolated server scanner is enabled; then explore modules, features, relationships, and source evidence.
- `/architecture` — permanent redirect to `/` for existing bookmarks.
- `/examples/legacy-pricing` — the trusted pricing investigation example, including its existing investigation API and operator-only verification workflow.

Run locally with `npm run dev`. Browser directory scans stay in the browser; see [archaeology documentation](docs/archaeology.md) for scanner limits and the CLI alternative. Controlled public GitHub scans require the server setup in [GitHub ingestion documentation](docs/github-ingestion.md).

GitHub App sign-in and selected private repository scanning are documented in [GitHub App setup](docs/github-app.md).

## 🎯 The Problem

Millions of software applications contain critical business rules buried inside aging codebases, undocumented functions, and complex dependencies.

When original developers leave, organizations risk losing the knowledge needed to maintain, modernize, or safely rebuild these systems.

Traditional code analysis tools identify syntax errors, dependencies, and vulnerabilities, but often struggle to explain why software behaves the way it does.

## 💡 Our Solution

CodeArchaeologist AI aims to act as an autonomous software archaeologist, investigating legacy repositories to reconstruct the business knowledge hidden within their source code.

### Planned Capabilities

- **Autonomous Repository Investigation:** Explore codebases and identify important application components.
- **Business Logic Reconstruction:** Infer undocumented rules, workflows, and decision paths.
- **Evidence-Based Reasoning:** Connect discoveries to specific source files and code locations.
- **Executable Test Generation:** Generate tests to validate reconstructed behavior.
- **Sandboxed Verification:** Execute supported tests in isolated environments.
- **Knowledge Reconstruction:** Produce structured documentation explaining verified application behavior.

## 🧠 AI Architecture

The project will use Meta's AI models for reasoning, code understanding, and agent decision-making.

The planned architecture combines:

- Meta Model API / compatible Meta open-weight models
- Autonomous agent orchestration
- Deterministic source-code analysis
- Evidence tracking
- Sandboxed test execution
- Verification and reporting

## 🛠️ Planned Technology Stack

- **Frontend:** Next.js, TypeScript, Tailwind CSS
- **Backend:** Node.js, TypeScript
- **AI:** Meta AI models
- **Database:** PostgreSQL
- **Testing:** Vitest
- **Version Control:** GitHub

The stack may evolve during development.

## 🚧 Development Status

**Status: Repository Intelligence workspace and trusted Legacy Pricing example available — October 2026**

This project is being developed from scratch during the Meta Global AI Developer Hackathon.

The repository workspace provides local graph generation and exploration; the broader capabilities listed above remain a development roadmap unless documented as implemented.

## 🏆 Hackathon

**Event:** Meta Global AI Developer Hackathon 2026  
**Track:** Indie Developer  
**Team:** Gevalinho Labs  
**Development Started:** October 27, 2026  
**Submission Deadline:** November 4, 2026

## 🔐 Security Principles

CodeArchaeologist AI is designed around secure repository handling, isolated execution, evidence-backed findings, and controlled agent permissions.

## 📄 License

MIT License

---

**Built with curiosity, engineering discipline, and a mission to recover the knowledge hidden inside software.**
