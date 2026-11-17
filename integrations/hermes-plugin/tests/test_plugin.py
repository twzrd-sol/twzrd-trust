"""Offline checks for the TWZRD Intel Hermes plugin.

Run from the repository root:

    python3 integrations/hermes-plugin/tests/test_plugin.py

No production route is called. Lookups go to a stub on the loopback interface and
the npm and node subprocesses are replaced, so the suite needs neither network access
nor Node.js. Standard library only.
"""

import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

PLUGIN_DIR = Path(__file__).resolve().parents[1]
SOL = "Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS"
EVM = "0x1111111111111111111111111111111111111111"


def _load_plugin():
    """Import the plugin the way a loader does: as a package rooted at its directory."""
    name = "twzrd_intel_plugin_under_test"
    spec = importlib.util.spec_from_file_location(
        name, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)]
    )
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    return package, sys.modules[f"{name}.tools"], sys.modules[f"{name}.schemas"]


PLUGIN, TOOLS, SCHEMAS = _load_plugin()


def _manifest_list(key: str) -> list[str]:
    """Read one top-level list from plugin.yaml without a YAML dependency."""
    items, inside = [], False
    for line in (PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8").splitlines():
        if line.startswith(f"{key}:"):
            inside = True
            continue
        if inside:
            match = re.match(r"^\s+-\s+(\S+)\s*$", line)
            if not match:
                break
            items.append(match.group(1))
    return items


def _manifest_scalar(key: str) -> str:
    for line in (PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8").splitlines():
        if line.startswith(f"{key}:"):
            return line.split(":", 1)[1].strip().strip('"')
    raise AssertionError(f"plugin.yaml has no {key}")


class _Context:
    """Records what register() asks the host for."""

    def __init__(self):
        self.tools, self.skills = {}, {}

    def register_tool(self, name, toolset, schema, handler, **kwargs):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, **kwargs}

    def register_skill(self, name, path, **kwargs):
        self.skills[name] = Path(path)


class _Stub(BaseHTTPRequestHandler):
    seen: list = []
    status = 200

    def _serve(self):
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length).decode() if length else ""
        type(self).seen.append((self.command, self.path, body, self.headers.get("content-type")))
        out = json.dumps({"readiness_card": {"decision": "warn"}}).encode()
        self.send_response(type(self).status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = _serve

    def log_message(self, *args):
        pass


class RegistrationTest(unittest.TestCase):
    def setUp(self):
        self.ctx = _Context()
        PLUGIN.register(self.ctx)

    def test_registered_tools_equal_the_declared_capabilities(self):
        self.assertEqual(sorted(self.ctx.tools), sorted(_manifest_list("provides_tools")))
        self.assertEqual(_manifest_list("provides_tools"), list(SCHEMAS.SCHEMAS))

    def test_each_tool_has_a_complete_schema_and_one_toolset(self):
        for name, tool in self.ctx.tools.items():
            self.assertEqual(tool["toolset"], "twzrd-intel")
            self.assertEqual(tool["schema"]["name"], name)
            self.assertTrue(tool["schema"]["description"])
            parameters = tool["schema"]["parameters"]
            self.assertEqual(parameters["type"], "object")
            for required in parameters["required"]:
                self.assertIn(required, parameters["properties"])
            self.assertTrue(callable(tool["handler"]))

    def test_the_skill_file_is_registered_and_exists(self):
        self.assertEqual(list(self.ctx.skills), ["twzrd-intel"])
        self.assertTrue(self.ctx.skills["twzrd-intel"].is_file())

    def test_no_environment_variable_is_required(self):
        self.assertEqual(_manifest_scalar("requires_env"), "[]")


class PinTest(unittest.TestCase):
    def test_the_verifier_is_pinned_to_an_exact_version(self):
        self.assertRegex(TOOLS.VERIFIER_PACKAGE, r"^twzrd-receipt-verifier@\d+\.\d+\.\d+$")

    def test_the_readme_names_the_same_verifier_pin(self):
        readme = (PLUGIN_DIR / "README.md").read_text(encoding="utf-8")
        self.assertIn(TOOLS.VERIFIER_PACKAGE, readme)

    def test_versions_agree_across_manifest_skill_and_user_agent(self):
        version = _manifest_scalar("version")
        skill = (PLUGIN_DIR / "skills" / "twzrd-intel" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn(f"\nversion: {version}\n", skill)
        self.assertEqual(TOOLS.USER_AGENT, f"twzrd-hermes-plugin/{version}")

    def test_the_issuer_key_is_the_same_in_schema_and_skill(self):
        skill = (PLUGIN_DIR / "skills" / "twzrd-intel" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn(SCHEMAS.ISSUER_PUBKEY, skill)

    def test_the_trusted_key_is_not_a_tool_argument(self):
        params = SCHEMAS.SCHEMAS["twzrd_verify_receipt"]["parameters"]
        self.assertEqual(sorted(params["properties"]), ["max_age_seconds", "receipt_path"])
        self.assertIs(params["additionalProperties"], False)

    def test_the_lockfile_pins_the_verifier_and_every_dependency_by_integrity(self):
        name, version = TOOLS.VERIFIER_PACKAGE.split("@")
        manifest = json.loads((PLUGIN_DIR / "verifier" / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["dependencies"], {name: version})
        lock = json.loads((PLUGIN_DIR / "verifier" / "package-lock.json").read_text(encoding="utf-8"))
        packages = {k: v for k, v in lock["packages"].items() if k}
        self.assertEqual(packages[f"node_modules/{name}"]["version"], version)
        self.assertGreaterEqual(len(packages), 4)
        for path, entry in packages.items():
            with self.subTest(package=path):
                self.assertRegex(entry["version"], r"^\d+\.\d+\.\d+$")
                self.assertTrue(entry["integrity"].startswith("sha512-"))
                self.assertTrue(entry["resolved"].startswith("https://registry.npmjs.org/"))
                self.assertNotIn("hasInstallScript", entry)


class LookupTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), _Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = mock.patch.object(TOOLS, "BASE_URL", f"http://127.0.0.1:{cls.server.server_port}")
        cls.base.start()

    @classmethod
    def tearDownClass(cls):
        cls.base.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        _Stub.seen.clear()
        _Stub.status = 200

    def test_preflight_posts_the_documented_body(self):
        out = json.loads(
            TOOLS.handle_preflight(
                {"pay_to": SOL, "resource_url": "https://x.example/r", "price_usdc": 0.05}
            )
        )
        method, path, body, content_type = _Stub.seen[-1]
        self.assertEqual((method, path), ("POST", "/v1/intel/preflight"))
        self.assertEqual(
            json.loads(body),
            {"seller_wallet": SOL, "resource_url": "https://x.example/r", "price_usdc": 0.05},
        )
        self.assertEqual(content_type, "application/json")
        self.assertIs(out["ok"], True)
        self.assertEqual(out["data"]["readiness_card"]["decision"], "warn")

    def test_preflight_sends_only_the_wallet_when_nothing_else_is_given(self):
        TOOLS.handle_preflight({"pay_to": EVM, "price_usdc": True, "resource_url": "  "})
        self.assertEqual(json.loads(_Stub.seen[-1][2]), {"seller_wallet": EVM})

    def test_merchant_card_is_a_get_with_no_body(self):
        out = json.loads(TOOLS.handle_merchant_card({"pay_to": EVM}))
        method, path, body, _ = _Stub.seen[-1]
        self.assertEqual((method, path), ("GET", f"/v1/intel/merchant_card/{EVM}"))
        self.assertEqual(body, "")
        self.assertIs(out["ok"], True)

    def test_placeholders_and_junk_never_reach_the_network(self):
        for junk in ["{seller_wallet}", "", "test", "../admin", None, 42, SOL + "/../x", "0x12"]:
            with self.subTest(pay_to=junk):
                for handler in (TOOLS.handle_preflight, TOOLS.handle_merchant_card):
                    out = json.loads(handler({"pay_to": junk}))
                    self.assertIs(out["ok"], False)
                    self.assertEqual(out["status"], 0)
        self.assertEqual(_Stub.seen, [])

    def test_an_http_error_is_ok_false_with_the_status(self):
        _Stub.status = 503
        out = json.loads(TOOLS.handle_preflight({"pay_to": SOL}))
        self.assertIs(out["ok"], False)
        self.assertEqual(out["status"], 503)

    def test_handlers_accept_the_dispatch_keyword_arguments(self):
        out = json.loads(TOOLS.handle_merchant_card({"pay_to": SOL}, task_id="t", session_id="s"))
        self.assertIs(out["ok"], True)


class UnreachableTest(unittest.TestCase):
    def test_an_unreachable_host_is_ok_false_with_status_zero(self):
        server = HTTPServer(("127.0.0.1", 0), _Stub)
        port = server.server_port
        server.server_close()
        with mock.patch.object(TOOLS, "BASE_URL", f"http://127.0.0.1:{port}"):
            out = json.loads(TOOLS.handle_merchant_card({"pay_to": SOL}))
        self.assertIs(out["ok"], False)
        self.assertEqual(out["status"], 0)


class VerifyReceiptTest(unittest.TestCase):
    NODE, NPM = "/usr/bin/node", "/usr/bin/npm"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.receipt = Path(self.tmp.name) / "receipt.json"
        self.receipt.write_text("{}", encoding="utf-8")
        self.cache = Path(self.tmp.name) / "cache"
        patcher = mock.patch.object(TOOLS, "_cache_root", return_value=self.cache)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _fake_run(self, verify_rc=0, install_rc=0):
        def run(cmd, **kwargs):
            if cmd[0] == self.NPM:
                if install_rc == 0:
                    script = Path(kwargs["cwd"]).joinpath(*TOOLS._VERIFIER_SCRIPT)
                    script.parent.mkdir(parents=True)
                    script.write_text("// stub", encoding="utf-8")
                return subprocess.CompletedProcess(cmd, install_rc, stdout="", stderr="npm said no\n")
            return subprocess.CompletedProcess(cmd, verify_rc, stdout="out\n", stderr="err\n")

        return run

    def _run(self, args, verify_rc=0, install_rc=0, which=None, environ=None):
        which = {"node": self.NODE, "npm": self.NPM} if which is None else which
        with mock.patch.object(TOOLS.shutil, "which", side_effect=which.get), mock.patch.object(
            TOOLS.subprocess, "run", side_effect=self._fake_run(verify_rc, install_rc)
        ) as run, mock.patch.dict(TOOLS.os.environ, environ or {"PATH": "/usr/bin", "HOME": "/h"}, clear=True):
            return json.loads(TOOLS.handle_verify_receipt(args)), run

    def test_the_verifier_is_installed_from_the_lockfile_with_scripts_disabled(self):
        _, run = self._run({"receipt_path": str(self.receipt)})
        install = run.call_args_list[0]
        self.assertEqual(install.args[0], [self.NPM, "ci", "--ignore-scripts", "--no-audit", "--no-fund"])
        self.assertIs(install.kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(install.kwargs["timeout"], 120)
        self.assertEqual(len(run.call_args_list), 2)
        installed = [p for p in self.cache.iterdir()]
        self.assertEqual(len(installed), 1)
        self.assertRegex(installed[0].name, r"^verifier-[0-9a-f]{16}$")
        for name in ("package.json", "package-lock.json"):
            self.assertEqual(
                (installed[0] / name).read_bytes(), (PLUGIN_DIR / "verifier" / name).read_bytes()
            )

    def test_a_second_call_reuses_the_install(self):
        self._run({"receipt_path": str(self.receipt)})
        _, run = self._run({"receipt_path": str(self.receipt)})
        self.assertEqual([c.args[0][0] for c in run.call_args_list], [self.NODE])

    def test_the_command_is_the_installed_verifier_with_the_pinned_key(self):
        out, run = self._run({"receipt_path": str(self.receipt), "max_age_seconds": 3600})
        verify = run.call_args_list[-1]
        script = next(self.cache.iterdir()).joinpath(*TOOLS._VERIFIER_SCRIPT)
        self.assertEqual(
            verify.args[0],
            [self.NODE, str(script), str(self.receipt.resolve()), "--pubkey", SCHEMAS.ISSUER_PUBKEY,
             "--max-age", "3600"],
        )
        self.assertIs(verify.kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(verify.kwargs["timeout"], 30)
        self.assertEqual(
            out,
            {
                "ok": True,
                "valid": True,
                "issuer_pubkey": SCHEMAS.ISSUER_PUBKEY,
                "verifier": TOOLS.VERIFIER_PACKAGE,
                "exit_code": 0,
                "stdout": "out",
                "stderr": "err",
            },
        )

    def test_child_processes_get_a_minimal_environment(self):
        environ = {
            "PATH": "/usr/bin",
            "HOME": "/h",
            "npm_config_cache": "/c",
            "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org/",
            "OPENAI_API_KEY": "sk-secret",
            "ANTHROPIC_API_KEY": "secret",
            "OPENROUTER_API_KEY": "secret",
            "NPM_TOKEN": "secret",
            "NODE_OPTIONS": "--require /tmp/x.js",
            "NODE_PATH": "/tmp",
            "npm_config_script_shell": "/tmp/sh",
            "HTTPS_PROXY": "http://user:pw@proxy",
        }
        _, run = self._run({"receipt_path": str(self.receipt)}, environ=environ)
        self.assertEqual(len(run.call_args_list), 2)
        for call in run.call_args_list:
            with self.subTest(cmd=call.args[0][0]):
                self.assertEqual(
                    call.kwargs["env"],
                    {
                        "PATH": "/usr/bin",
                        "HOME": "/h",
                        "npm_config_cache": "/c",
                        "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org/",
                    },
                )

    def test_a_caller_supplied_key_is_refused_before_any_subprocess(self):
        other = "2ELSDxLqNp6wTq7mnpWqUkcYQrBmXTtGRXsfdRZHYbqh"
        for key in [other, SCHEMAS.ISSUER_PUBKEY, "--fetch-key", "", None, 7]:
            with self.subTest(pubkey=key):
                out, run = self._run({"receipt_path": str(self.receipt), "pubkey": key})
                self.assertIs(out["valid"], False)
                self.assertIs(out["ok"], False)
                self.assertEqual(out["issuer_pubkey"], SCHEMAS.ISSUER_PUBKEY)
                self.assertIn("not an argument", out["error"])
                run.assert_not_called()

    def test_a_nonzero_exit_is_not_valid_and_still_names_the_key(self):
        out, _ = self._run({"receipt_path": str(self.receipt)}, verify_rc=1)
        self.assertIs(out["valid"], False)
        self.assertIs(out["ok"], False)
        self.assertEqual(out["exit_code"], 1)
        self.assertEqual(out["issuer_pubkey"], SCHEMAS.ISSUER_PUBKEY)

    def test_no_max_age_flag_unless_a_positive_integer_is_given(self):
        for value in [None, 0, -5, True, "3600", 1.5]:
            with self.subTest(max_age_seconds=value):
                _, run = self._run({"receipt_path": str(self.receipt), "max_age_seconds": value})
                self.assertNotIn("--max-age", run.call_args_list[-1].args[0])

    def test_a_missing_file_or_path_is_refused_before_any_subprocess(self):
        for args in [{}, {"receipt_path": ""}, {"receipt_path": str(self.receipt) + ".absent"}]:
            with self.subTest(args=args):
                out, run = self._run(args)
                self.assertIs(out["valid"], False)
                run.assert_not_called()

    def test_a_missing_node_or_npm_is_reported_not_raised(self):
        for which in [{"npm": self.NPM}, {"node": self.NODE}, {}]:
            with self.subTest(which=which):
                out, run = self._run({"receipt_path": str(self.receipt)}, which=which)
                self.assertIs(out["valid"], False)
                self.assertIn("Node.js", out["error"])
                run.assert_not_called()

    def test_a_failed_install_is_reported_and_leaves_nothing_behind(self):
        out, run = self._run({"receipt_path": str(self.receipt)}, install_rc=1)
        self.assertIs(out["valid"], False)
        self.assertIn("npm ci exit 1", out["error"])
        self.assertIn("npm said no", out["error"])
        self.assertEqual(len(run.call_args_list), 1)
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_a_timeout_is_reported_not_raised(self):
        for stage, word in [(self.NPM, "install timed out"), (self.NODE, "verifier timed out")]:
            with self.subTest(stage=stage):
                good = self._fake_run()

                def run(cmd, **kwargs):
                    if cmd[0] == stage:
                        raise subprocess.TimeoutExpired(cmd, 1)
                    return good(cmd, **kwargs)

                which = {"node": self.NODE, "npm": self.NPM}
                with mock.patch.object(TOOLS.shutil, "which", side_effect=which.get), mock.patch.object(
                    TOOLS.subprocess, "run", side_effect=run
                ):
                    out = json.loads(TOOLS.handle_verify_receipt({"receipt_path": str(self.receipt)}))
                self.assertIs(out["valid"], False)
                self.assertIn(word, out["error"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
