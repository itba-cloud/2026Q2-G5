#!/usr/bin/env python3
"""Run the manual Actions operations; never publish plans, state or passwords."""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
STATE_KEY = "elastic-worlds/evaluacion/terraform.tfstate"


def run(*command, capture=False):
    grouped = command[0] == "terraform" and not capture
    if grouped:
        phase = next(arg for arg in command[1:] if not arg.startswith("-"))
        print(f"::group::Terraform {phase}", flush=True)
    result = subprocess.run(command, cwd=ROOT, text=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
    if grouped:
        print("::endgroup::", flush=True)
    if result.returncode:
        # Captured AWS/state/plan responses may contain sensitive values.
        raise RuntimeError(f"Falló {command[0]} {command[1]} (código {result.returncode}). Revisar el paso del workflow.")
    return result.stdout if capture else None


def summary(text):
    destination = os.environ.get("GITHUB_STEP_SUMMARY")
    if destination:
        with open(destination, "a") as handle:
            handle.write(text + "\n")


def output_value(outputs, name):
    return outputs.get(name, {}).get("value", "")


def deployment_links(outputs, region, project):
    rows = []
    client = output_value(outputs, "client_website_url").rstrip("/")
    for title, value in [("Juego", client), ("Dashboard", f"{client}/dashboard.html" if client else ""),
                         ("API pública", output_value(outputs, "alb_url"))]:
        url = urlsplit(value)
        if url.scheme not in ("http", "https") or not url.netloc or any(c in value for c in "\n\r|<>()"):
            raise RuntimeError(f"Output {title} vacío o inválido; no se puede publicar el enlace.")
        rows.append(f"| {title} | [Abrir]({value}) |")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    guide = (f"\n[Guía de uso con capturas]({os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{repository}/blob/main/.docs/guia-usuario.md).\n"
             if repository else "\nVer `.docs/guia-usuario.md` para el recorrido con capturas.\n")
    return ("\n## Acceder a la aplicación\n\n| Acceso | Enlace |\n| --- | --- |\n" + "\n".join(rows)
            + f"\n\n**Monitoreo:** usuario `admin`. Abrir [Secrets Manager](https://console.aws.amazon.com/secretsmanager/?region={region}),"
            + f" elegir `{project}-metrics-password` y pulsar **Retrieve secret value**."
            + " La contraseña se ingresa en el dashboard y no se publica en este resumen.\n"
            + guide)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["plan", "deploy", "destroy"])
    parser.add_argument("--project", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{2,24}", args.project):
        parser.error("El proyecto debe tener 3–25 caracteres: minúsculas, números y guiones; empezar con una letra.")
    region = os.environ.get("AWS_REGION", "us-east-1")
    expected = os.environ.get("AWS_ACCOUNT_ID", "")
    if not re.fullmatch(r"\d{12}", expected):
        parser.error("Configurar AWS_ACCOUNT_ID en Settings > Secrets and variables > Actions > Variables del repositorio (12 dígitos).")
    if not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d+", region):
        parser.error("AWS_REGION inválida.")

    identity = json.loads(run("aws", "sts", "get-caller-identity", "--output", "json", capture=True))
    if identity["Account"] != expected:
        raise RuntimeError("Las credenciales AWS pertenecen a otra cuenta; corregir AWS_ACCOUNT_ID o renovar los tres secrets.")
    bucket = os.environ.get("AWS_STATE_BUCKET") or f"elastic-worlds-tfstate-{expected}"
    if not re.fullmatch(r"elastic-worlds-tfstate-[a-z0-9.-]+", bucket) or len(bucket) > 63:
        parser.error("AWS_STATE_BUCKET debe usar el prefijo elastic-worlds-tfstate- y tener hasta 63 caracteres.")

    os.environ.update(TF_IN_AUTOMATION="true", TF_INPUT="false", AWS_DEFAULT_REGION=region)
    summary(f"# Terraform: {args.operation}\n\n| Dato | Valor |\n| --- | --- |\n"
            f"| Cuenta | `{expected}` |\n| Región | `{region}` |\n| Proyecto | `{args.project}` |\n"
            f"| Backend | `{bucket}/{STATE_KEY}` |\n| Commit | `{os.environ.get('GITHUB_SHA', 'local')}` |\n")
    backend_mode = "--execute" if args.operation == "deploy" else "--check-only"
    run(sys.executable, "scripts/bootstrap-state-backend.py", "--region", region,
        "--bucket", bucket, backend_mode)
    head = subprocess.run(["aws", "s3api", "head-object", "--bucket", bucket, "--key", STATE_KEY,
                           "--region", region, "--output", "json"], cwd=ROOT, capture_output=True, text=True)
    if head.returncode and not any(code in head.stderr for code in ("404", "NoSuchKey", "NotFound")):
        raise RuntimeError("No se pudo comprobar el objeto de estado; revisar permisos antes de continuar.")
    has_state = head.returncode == 0
    if not has_state and args.operation != "deploy":
        raise RuntimeError("No hay un despliegue en este backend. Ejecutar Deploy antes de Plan o Destroy.")

    run("terraform", "-chdir=infra", "init", "-input=false", "-lockfile=readonly",
        f"-backend-config=bucket={bucket}", f"-backend-config=key={STATE_KEY}",
        f"-backend-config=region={region}", "-backend-config=encrypt=true", "-backend-config=use_lockfile=true")
    if has_state:
        state = json.loads(run("terraform", "-chdir=infra", "state", "pull", capture=True))
        existing = state.get("outputs", {}).get("snapshot_bucket_name", {}).get("value")
        recorded_projects = []
        for resource in state.get("resources", []):
            if resource.get("type") != "terraform_data" or resource.get("name") != "lab_buckets":
                continue
            for instance in resource.get("instances", []):
                value = instance.get("attributes", {}).get("input", {})
                # Raw state wraps terraform_data's dynamic input with type/value.
                value = value.get("value", value)
                recorded_projects.append(value.get("project"))
        if ((existing and existing != f"{args.project}-snapshots-{expected}")
                or any(project != args.project for project in recorded_projects)):
            raise RuntimeError("project_name no coincide con el entorno guardado. Usar el mismo prefijo del primer Deploy.")
        if not existing and not recorded_projects and any(r.get("mode") == "managed" for r in state.get("resources", [])):
            raise RuntimeError("El estado contiene recursos pero no identifica el proyecto; revisar el backend antes de continuar.")

    run("npm", "ci", "--prefix", "lobby-service")
    run("npm", "run", "package:lambda", "--prefix", "lobby-service")
    run("terraform", "-chdir=infra", "validate")
    variables = ["-var-file=environments/evaluacion.tfvars.example",
                 f"-var=project_name={args.project}", f"-var=aws_region={region}"]
    # Saved plans and their JSON may contain prior state: keep them ephemeral.
    with tempfile.TemporaryDirectory(prefix="ewo-actions-", dir=os.environ.get("RUNNER_TEMP")) as temporary:
        plan = str(Path(temporary) / "operation.tfplan")
        command = ["terraform", "-chdir=infra", "plan", "-input=false", "-no-color", "-lock-timeout=5m",
                   *variables, f"-out={plan}"]
        if args.operation == "destroy":
            command.append("-destroy")
        run(*command)
        plan_json = Path(temporary) / "plan.json"
        plan_json.write_text(run("terraform", "-chdir=infra", "show", "-json", plan, capture=True))
        run(sys.executable, "scripts/check-plan-no-iam.py", str(plan_json))
        run(sys.executable, "scripts/check-plan-no-secrets.py", str(plan_json))
        changes = Counter(action for resource in json.loads(plan_json.read_text()).get("resource_changes", [])
                          if resource.get("mode") == "managed" for action in resource["change"]["actions"])
        summary("\n## Plan\n\n| Crear | Actualizar | Eliminar |\n| --- | --- | --- |\n"
                f"| {changes['create']} | {changes['update']} | {changes['delete']} |\n")
        if args.operation == "plan":
            summary("\nPlan terminado. No se ejecutó apply. Deploy vuelve a planificar y aplica su propio plan en el mismo job.")
            return
        run("terraform", "-chdir=infra", "apply", "-input=false", "-no-color", "-lock-timeout=5m", plan)

    if args.operation == "deploy":
        outputs = json.loads(run("terraform", "-chdir=infra", "output", "-json", capture=True))
        summary(deployment_links(outputs, region, args.project))
    else:
        summary("\n## Entorno retirado\n\nSe aplicó el plan de destrucción. El backend y los buckets de datos/artefactos se conservan. "
                "Los snapshots siguen disponibles; Destroy no elimina esos datos.")


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        message = str(error)
        print(message, file=sys.stderr)
        summary("\n## La operación falló\n\nRevisar el paso rojo del run. Si venció el Learner Lab, renovar juntos "
                "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY y AWS_SESSION_TOKEN. Se conserva el backend para reintentar.")
        sys.exit(1)
