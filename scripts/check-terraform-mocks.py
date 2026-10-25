#!/usr/bin/env python3
"""Run the mock suite without loading personal tfvars, state or AWS credentials."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    root = Path(__file__).resolve().parents[1]
    cache = root / ".build"
    cache.mkdir(exist_ok=True)
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("TF_VAR_", "TF_CLI_ARGS", "AWS_"))
           and key not in {"TF_DATA_DIR", "TF_WORKSPACE", "TF_CLI_CONFIG_FILE"}}
    env.update(AWS_EC2_METADATA_DISABLED="true", AWS_CONFIG_FILE=os.devnull,
               AWS_SHARED_CREDENTIALS_FILE=os.devnull, TF_IN_AUTOMATION="true")
    plugin_cache = cache / "terraform-provider-cache"
    plugin_cache.mkdir(exist_ok=True)
    env.setdefault("TF_PLUGIN_CACHE_DIR", str(plugin_cache))

    def run(*command, cwd=root):
        subprocess.run(command, cwd=cwd, env=env, check=True)

    run("terraform", "-chdir=infra", "fmt", "-check", "-recursive")
    with tempfile.TemporaryDirectory(prefix="terraform-mocks-", dir=cache) as temporary:
        workspace = Path(temporary)
        infra = workspace / "infra"
        infra.mkdir()
        # Deliberately exclude *.tfvars, .terraform/, plans and local state.
        for source in (root / "infra").glob("*.tf"):
            shutil.copy2(source, infra / source.name)
        shutil.copy2(root / "infra/.terraform.lock.hcl", infra)
        for name in ("workflows", "tests"):
            shutil.copytree(root / "infra" / name, infra / name)
        if (root / "infra/modules").is_dir():
            shutil.copytree(root / "infra/modules", infra / "modules",
                            ignore=shutil.ignore_patterns(".terraform"))
        (workspace / "client").symlink_to(root / "client", target_is_directory=True)
        (workspace / "scripts").symlink_to(root / "scripts", target_is_directory=True)
        lobby = workspace / "lobby-service"
        lobby.mkdir()
        shutil.copy2(root / "lobby-service/package.json", lobby)
        (lobby / "src").symlink_to(root / "lobby-service/src", target_is_directory=True)
        # filebase64sha256 is evaluated even when the provider is mocked.
        run("npm", "--prefix", "lobby-service", "run", "package:lambda", "--",
            str(lobby / "dist/lambdas"))
        run("terraform", "init", "-backend=false", "-input=false", "-lockfile=readonly", cwd=infra)
        run("terraform", "validate", cwd=infra)
        run("terraform", "test", "-no-color", cwd=infra)
        # Each module has its own mocked tests; the root cannot see their resources.
        for module in sorted((infra / "modules").glob("*/tests")):
            run("terraform", "init", "-backend=false", "-input=false", "-lockfile=readonly", cwd=module.parent)
            run("terraform", "test", "-no-color", cwd=module.parent)


if __name__ == "__main__":
    main()
