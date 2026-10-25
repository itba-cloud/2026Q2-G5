#!/usr/bin/env python3
"""Read-only checks; never deploys resources or certifies write permissions."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]


class CheckError(Exception):
    pass


def command(argv):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=30,
                                env={**os.environ, "AWS_PAGER": "", "AWS_MAX_ATTEMPTS": "1"})
    except FileNotFoundError:
        raise CheckError(f"No se encontró {argv[0]}") from None
    except subprocess.TimeoutExpired:
        raise CheckError("Timeout (30 s)") from None
    if result.returncode:
        # Do not echo stderr: it can contain identifiers, request data or secrets.
        match = re.search(r"\((\w+)\) when calling", result.stderr)
        code = match.group(1) if match else "CommandFailed"
        if "Unable to locate credentials" in result.stderr:
            code = "NoCredentials"
        raise CheckError(code)
    return result.stdout.strip()


class Preflight:
    def __init__(self, args):
        self.args = args
        self.results = []

    def record(self, operation, status, evidence, alternative=""):
        self.results.append(dict(operation=operation, status=status,
                                 evidence=evidence, alternative=alternative))
        print(f"{status}: {operation}: {evidence}")

    def check(self, operation, probe, success="Lectura permitida; creación no comprobada"):
        try:
            value = probe()
            self.record(operation, "PASS", success)
            return value
        except (CheckError, json.JSONDecodeError, KeyError) as error:
            reason = str(error) if isinstance(error, CheckError) else "Respuesta inesperada"
            self.record(operation, "BLOCKED", reason,
                        "Renovar las tres credenciales si vencieron; revisar región, rol y políticas si hay denegación")
            return None

    def aws(self, *args):
        return json.loads(command(["aws", *args, "--region", self.args.region,
                                   "--output", "json", "--no-cli-pager",
                                   "--cli-connect-timeout", "5", "--cli-read-timeout", "15"]))

    def local(self):
        expected = (ROOT / ".terraform-version").read_text().strip()

        def terraform():
            actual = json.loads(command(["terraform", "version", "-json"]))["terraform_version"]
            if actual != expected:
                raise CheckError(f"Se requiere Terraform {expected}; instalado {actual}")
        self.check("local/Terraform", terraform, f"Versión fijada {expected}")

        def node():
            if not command(["node", "--version"]).startswith("v22."):
                raise CheckError("Se requiere Node 22")
        self.check("local/Node", node, "Node 22")
        def python():
            actual = command(["python3", "--version"]).split()[1]
            if tuple(map(int, actual.split(".")[:2])) < (3, 10):
                raise CheckError("Se requiere Python 3.10+")
        self.check("local/Python", python, "Python 3.10+")

        def aws_cli():
            if not command(["aws", "--version"]).startswith("aws-cli/2."):
                raise CheckError("Se requiere AWS CLI v2")
        self.check("local/AWS CLI", aws_cli, "AWS CLI v2")
        for name, argv in [("npm", ["npm", "--version"]), ("zip", ["zip", "-v"]),
                           ("gzip", ["gzip", "--version"]), ("Git", ["git", "--version"])]:
            self.check(f"local/{name}", lambda argv=argv: command(argv), "Herramienta disponible")
        def docker():
            if not command(["docker", "info", "--format", "{{.OSType}}/{{.Architecture}}"]).startswith("linux/"):
                raise CheckError("Docker debe ejecutar contenedores Linux")
        self.check("local/Docker daemon", docker,
                   "Daemon accesible; no acredita build linux/amd64 ni bind mounts de Snap")
        self.record("local/Docker linux/amd64", "PENDING",
                    "Verificar con build desde fuente; Java 17/Maven se ejecutan dentro de Docker",
                    "Usar TMPDIR bajo .build/tmp si Docker proviene de Snap")

    def trust(self, role, services):
        data = self.check(f"iam:GetRole/{role}", lambda: self.aws("iam", "get-role", "--role-name", role.rsplit("/", 1)[-1]))
        if data is None:
            return
        statements = data["Role"]["AssumeRolePolicyDocument"].get("Statement", [])
        if isinstance(statements, dict):
            statements = [statements]
        for service in services:
            found = False
            for statement in statements:
                principal = statement.get("Principal", {})
                principals = principal.get("Service", []) if isinstance(principal, dict) else []
                actions = statement.get("Action", [])
                principals = [principals] if isinstance(principals, str) else principals
                actions = [actions] if isinstance(actions, str) else actions
                if statement.get("Effect") == "Allow" and service in principals and "sts:AssumeRole" in actions:
                    found = True
            self.record(f"trust/{service}", "PASS" if found else "BLOCKED",
                        "Allow declarado; condiciones y Deny requieren revisión" if found else "Falta Allow explícito sts:AssumeRole para el servicio",
                        "Usar un rol existente autorizado; no crear ni modificar roles del Lab")

    def remote(self):
        identity = self.check("sts:GetCallerIdentity", lambda: self.aws("sts", "get-caller-identity"), "Sesión vigente")
        if identity is None:
            self.record("AWS/resto de verificaciones", "PENDING", "No ejecutadas: sesión no disponible")
            return
        roles = {}
        for role, service in [(self.args.lambda_role, "lambda.amazonaws.com"),
                              (self.args.workflow_role, "states.amazonaws.com"),
                              (self.args.scheduler_role, "scheduler.amazonaws.com"),
                              (self.args.lab_role, "ec2.amazonaws.com"),
                              (self.args.lab_role, "ecs-tasks.amazonaws.com"),
                              (self.args.lab_role, "kinesisanalytics.amazonaws.com")]:
            roles.setdefault(role, []).append(service)
        for role, services in roles.items():
            self.trust(role, services)
        profile = self.check("iam:GetInstanceProfile", lambda: self.aws("iam", "get-instance-profile", "--instance-profile-name", self.args.instance_profile))
        if profile is not None:
            matches = self.args.lab_role.rsplit("/", 1)[-1] in [role["RoleName"] for role in profile["InstanceProfile"]["Roles"]]
            self.record("IAM/perfil EC2", "PASS" if matches else "BLOCKED", "Contiene el rol esperado" if matches else "No contiene el rol esperado")
        zones = self.check("ec2:DescribeAvailabilityZones", lambda: self.aws("ec2", "describe-availability-zones", "--filters", "Name=state,Values=available"))
        if zones is not None:
            available = len(zones["AvailabilityZones"])
            self.record("EC2/dos AZ", "PASS" if available >= 2 else "BLOCKED", f"{available} AZ disponibles")
        offers = self.check("rds:DescribeOrderableDBInstanceOptions", lambda: self.aws(
            "rds", "describe-orderable-db-instance-options", "--engine", "postgres", "--engine-version", self.args.postgres_version,
            "--db-instance-class", self.args.db_instance_class, "--vpc"))
        if offers is not None:
            options = offers["OrderableDBInstanceOptions"]
            self.record("RDS/catálogo", "PASS" if options else "BLOCKED",
                        f"postgres {self.args.postgres_version} / {self.args.db_instance_class}: {len(options)} opciones")
            capable = any(option.get("MultiAZCapable") for option in options)
            self.record("RDS/catálogo Multi-AZ", "PASS" if capable else "BLOCKED",
                        "MultiAZCapable disponible; falta probar creación" if capable else "Combinación Multi-AZ no disponible")
        probes = [
            ("lambda:GetAccountSettings", ("lambda", "get-account-settings")),
            ("states:ListStateMachines", ("stepfunctions", "list-state-machines", "--max-results", "1")),
            ("scheduler:ListSchedules", ("scheduler", "list-schedules", "--max-results", "1")),
            ("secretsmanager:ListSecrets", ("secretsmanager", "list-secrets", "--max-results", "1")),
            ("elasticache:DescribeReplicationGroups", ("elasticache", "describe-replication-groups", "--max-records", "20")),
            ("ecs:ListClusters", ("ecs", "list-clusters", "--max-results", "1")),
            ("ecr:DescribeRepositories", ("ecr", "describe-repositories", "--max-results", "1")),
            ("logs:DescribeLogGroups", ("logs", "describe-log-groups", "--limit", "1")),
            ("kinesisanalytics:ListApplications", ("kinesisanalyticsv2", "list-applications", "--limit", "1")),
            ("kinesis:ListStreams", ("kinesis", "list-streams", "--limit", "1")),
            ("dynamodb:ListTables", ("dynamodb", "list-tables", "--limit", "1")),
        ]
        if not self.args.no_npc_autoscaling:
            probes.append(("application-autoscaling:DescribeScalableTargets",
                           ("application-autoscaling", "describe-scalable-targets", "--service-namespace", "ecs", "--max-results", "1")))
        for operation, argv in probes:
            self.check(operation, lambda argv=argv: self.aws(*argv))
        cache = self.check("elasticache:DescribeCacheEngineVersions", lambda: self.aws(
            "elasticache", "describe-cache-engine-versions", "--engine", "redis", "--engine-version", self.args.cache_engine_version))
        if cache is not None:
            self.record("ElastiCache/catálogo engine", "PASS" if cache["CacheEngineVersions"] else "BLOCKED",
                        f"Redis {self.args.cache_engine_version}; el tamaño {self.args.cache_node_type} requiere prueba de creación")
        if self.args.state_bucket:
            for operation, argv in [
                ("s3:GetBucketVersioning", ("s3api", "get-bucket-versioning")),
                ("s3:GetEncryptionConfiguration", ("s3api", "get-bucket-encryption")),
                ("s3:GetBucketPublicAccessBlock", ("s3api", "get-public-access-block")),
            ]:
                data = self.check(operation, lambda argv=argv: self.aws(*argv, "--bucket", self.args.state_bucket))
                if data is None:
                    continue
                if operation == "s3:GetBucketVersioning":
                    valid = data.get("Status") == "Enabled"
                elif operation == "s3:GetEncryptionConfiguration":
                    valid = bool(data.get("ServerSideEncryptionConfiguration", {}).get("Rules"))
                else:
                    valid = all(data.get("PublicAccessBlockConfiguration", {}).get(key) is True for key in (
                        "BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"))
                self.record(f"backend/{operation}", "PASS" if valid else "BLOCKED", "Configuración requerida presente" if valid else "Configuración requerida incompleta")
        else:
            self.record("backend/S3", "PENDING", "No se indicó --state-bucket; bootstrap y bloqueo corresponden a tarea 09")
        self.record("AWS/permisos efectivos", "PENDING",
                    "No se ejecutaron escrituras, iam:PassRole, ENI ni pruebas de roles en runtime",
                    "Desplegar y retirar un entorno aislado con el mismo operador; conservar evidencia de creación y limpieza")
        self.record("ElastiCache/tamaño y backend/lock", "PENDING",
                    "Las lecturas no prueban CreateReplicationGroup ni PutObject/DeleteObject sobre estado y .tflock")

    def execute(self):
        if not self.args.aws_only:
            self.local()
        if not self.args.local_only:
            self.remote()
        report = dict(checked_at=datetime.now(timezone.utc).isoformat(), region=self.args.region,
                      mode="read-only", writes_verified=False, results=self.results)
        if self.args.json_out:
            output = Path(self.args.json_out)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        if any(item["status"] == "BLOCKED" for item in self.results):
            return 1
        return 2 if any(item["status"] == "PENDING" for item in self.results) else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1")))
    parser.add_argument("--lambda-role", default="LabRole")
    parser.add_argument("--workflow-role", default="LabRole")
    parser.add_argument("--scheduler-role", default="LabRole")
    parser.add_argument("--lab-role", default="LabRole")
    parser.add_argument("--instance-profile", default="LabInstanceProfile")
    parser.add_argument("--postgres-version", default="18.3")
    parser.add_argument("--db-instance-class", default="db.t3.micro")
    parser.add_argument("--cache-engine-version", default="7.1", help="Candidato para tarea 04; no cambia Terraform")
    parser.add_argument("--cache-node-type", default="cache.t3.micro", help="Candidato para tarea 04; creación pendiente")
    parser.add_argument("--no-npc-autoscaling", action="store_true")
    parser.add_argument("--state-bucket")
    parser.add_argument("--json-out")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--local-only", action="store_true")
    mode.add_argument("--aws-only", action="store_true")
    return Preflight(parser.parse_args()).execute()


if __name__ == "__main__":
    raise SystemExit(main())
