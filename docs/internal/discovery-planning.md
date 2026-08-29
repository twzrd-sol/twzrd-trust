# Internal Discovery & Adoption Planning

> **Note:** Internal planning and distribution roadmap. Not part of public integrator documentation.

---

## Discovery Channels & Integrations

- **Skill Distribution:**
  - ClawHub / OpenClaw skill listing (`npx clawhub install twzrd-trust`)
  - Canonical live skill at `https://intel.twzrd.xyz/skill.md`
- **MCP Catalogs:**
  - Glama (`https://glama.ai/mcp/servers/twzrd-sol/twzrd-trust`)
  - PulseMCP & Smithery listings
- **Direct Agent Discovery:**
  - `.well-known/agent.json` + `llms.txt` on `intel.twzrd.xyz`
  - Resource join overlay at `GET /v1/intel/resources`

## Operational Metrics & Success Criteria
- **North Star:** Pre-spend preflight evaluation traffic and zero-spend block enforcement on live agent networks.
- **Verification Gates:** Automated CI coverage across clean clone, full test suite, deterministic demo execution, and portable V6 tamper proof.
