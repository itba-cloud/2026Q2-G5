#!/usr/bin/env python3
"""Fail if a Terraform plan would create or change any IAM resource, in any module.

The Learner Lab does not allow creating IAM roles, and the external modules can
create them when an input changes. terraform test cannot see resources inside
child modules, so this check runs on the full plan:

    terraform plan -out=tfplan && terraform show -json tfplan > plan.json
    python3 scripts/check-plan-no-iam.py plan.json
"""
import json
import sys

if len(sys.argv) != 2:
    sys.exit("usage: check-plan-no-iam.py <plan.json>")

with open(sys.argv[1]) as handle:
    plan = json.load(handle)

if "resource_changes" not in plan or "planned_values" not in plan:
    sys.exit("Not a plan: pass the output of `terraform show -json <planfile>`.")

# terraform plan -out writes the file even when planning fails, and -target
# plans only part of the configuration. Either would hide resources that were
# never evaluated.
if plan.get("errored") or plan.get("complete") is False:
    sys.exit("The plan is incomplete (planning failed or used -target). Run a full plan.")

offending = [
    f"{change['address']} ({'/'.join(change['change']['actions'])})"
    for change in plan.get("resource_changes", [])
    if change["mode"] == "managed"
    and change["type"].startswith("aws_iam_")
    and change["change"]["actions"] != ["no-op"]
]

if offending:
    print("The plan creates or changes IAM resources, which the Learner Lab does not allow:")
    print("\n".join(f"  - {address}" for address in offending))
    sys.exit(1)

checked = sum(1 for change in plan["resource_changes"] if change["mode"] == "managed")
print(f"OK: the plan creates or changes no IAM resource ({checked} managed resources checked).")
