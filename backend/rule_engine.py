"""
Stage 4 deliverable: Rule-Based Compliance Engine.

Design goals (from the roadmap):
- Deterministic: same profile always produces the same result.
- Explainable: every result carries a plain-English reason a reviewer can check.
- Safe on bad input: missing/invalid profile fields never crash the engine.

How matching works
-------------------
Each compliance record in compliance_data.json has a "condition_groups" list.
A rule is APPLICABLE if the profile satisfies *any one* group (OR of ANDs).
This lets a single rule express "either/or" legal conditions — e.g. the
Factories Act licence, which triggers at 10+ employees *with* power OR
20+ employees *without* power.

Supported condition keys inside a group (all keys in a group are AND-ed):
    state              -> profile.state must be in this list
    business_type      -> profile.business_type must be in this list
    industry           -> profile.industry must be in this list
    min_employees      -> profile.employees >= value
    max_employees      -> profile.employees <= value
    min_turnover_lakhs -> profile.turnover_lakhs >= value
    max_turnover_lakhs -> profile.turnover_lakhs <= value
    uses_power         -> profile.uses_power must equal value (bool)
"""

import json
import os

DATA_PATH = os.path.join(os.path.dirname(__file__), "compliance_data.json")

# Rules where the profile's own "already registered" flag should change the
# displayed status from a bare Applicable/Not Applicable into something more
# useful for the business owner.
REGISTRATION_FLAG_FOR_RULE = {
    "C001": "gst_registered",
    "C002": "udyam_registered",
    "C003": "factory_status",
}


def load_compliance_rules():
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _condition_group_matches(group: dict, profile: dict) -> bool:
    """Evaluate a single AND-group of conditions against a profile dict."""
    for key, expected in group.items():
        if key == "state":
            if profile.get("state") not in expected:
                return False
        elif key == "business_type":
            if profile.get("business_type") not in expected:
                return False
        elif key == "industry":
            if profile.get("industry") not in expected:
                return False
        elif key == "min_employees":
            if (profile.get("employees") or 0) < expected:
                return False
        elif key == "max_employees":
            if (profile.get("employees") or 0) > expected:
                return False
        elif key == "min_turnover_lakhs":
            if (profile.get("turnover_lakhs") or 0) < expected:
                return False
        elif key == "max_turnover_lakhs":
            if (profile.get("turnover_lakhs") or 0) > expected:
                return False
        elif key == "uses_power":
            if bool(profile.get("uses_power")) != bool(expected):
                return False
        # Unknown condition keys are ignored rather than crashing the engine,
        # so a future knowledge-base field never breaks Review-1 demos.
    return True


def _explain(rule: dict, matched_group: dict | None, profile: dict) -> str:
    """Build a short, reviewer-readable reason for the decision using existing conditions."""
    if rule.get("needs_verification"):
        return f"Applicability for '{rule['name']}' requires verification against latest legal notification."

    if matched_group is None:
        groups = rule.get("condition_groups", [])
        if not groups:
            return f"No applicability condition for '{rule['name']}' was met by this profile."

        reasons = []
        for g in groups:
            sub = []
            if "state" in g and profile.get("state") not in g["state"]:
                sub.append(f"state '{profile.get('state')}' is outside {g['state']}")
            if "business_type" in g and profile.get("business_type") not in g["business_type"]:
                sub.append(f"business type '{profile.get('business_type')}' is not in {g['business_type']}")
            if "min_employees" in g and (profile.get("employees") or 0) < g["min_employees"]:
                sub.append(f"employees ({profile.get('employees') or 0}) < threshold of {g['min_employees']}")
            if "max_employees" in g and (profile.get("employees") or 0) > g["max_employees"]:
                sub.append(f"employees ({profile.get('employees') or 0}) > limit of {g['max_employees']}")
            if "min_turnover_lakhs" in g and (profile.get("turnover_lakhs") or 0) < g["min_turnover_lakhs"]:
                sub.append(f"turnover ({profile.get('turnover_lakhs') or 0} lakh) < threshold of {g['min_turnover_lakhs']} lakh")
            if "max_turnover_lakhs" in g and (profile.get("turnover_lakhs") or 0) > g["max_turnover_lakhs"]:
                sub.append(f"turnover ({profile.get('turnover_lakhs') or 0} lakh) > limit of {g['max_turnover_lakhs']} lakh")
            if "uses_power" in g and bool(profile.get("uses_power")) != bool(g["uses_power"]):
                sub.append(f"uses power = {profile.get('uses_power')} (requires {g['uses_power']})")
            if sub:
                reasons.append(" and ".join(sub))

        if reasons:
            if len(reasons) > 1:
                return "Not applicable: did not meet condition (" + ") nor (".join(reasons) + ")."
            return f"Not applicable: {reasons[0]}."

        return f"No applicability condition for '{rule['name']}' was met by this profile."

    parts = []
    if "min_employees" in matched_group:
        parts.append(f"employees ({profile.get('employees')}) >= {matched_group['min_employees']}")
    if "max_employees" in matched_group:
        parts.append(f"employees ({profile.get('employees')}) <= {matched_group['max_employees']}")
    if "min_turnover_lakhs" in matched_group:
        parts.append(f"turnover ({profile.get('turnover_lakhs')} lakh) >= {matched_group['min_turnover_lakhs']} lakh")
    if "max_turnover_lakhs" in matched_group:
        parts.append(f"turnover ({profile.get('turnover_lakhs')} lakh) <= {matched_group['max_turnover_lakhs']} lakh")
    if "state" in matched_group:
        parts.append(f"state = {profile.get('state')}")
    if "business_type" in matched_group:
        parts.append(f"business type = {profile.get('business_type')}")
    if "uses_power" in matched_group:
        parts.append(f"uses power = {profile.get('uses_power')}")

    return "Applicable because " + " and ".join(parts) + "." if parts else "Applicable to all businesses."


def evaluate_profile(profile: dict, rules: list | None = None) -> list:
    """
    Core engine entry point.
    Takes a business profile dict, returns a list of result dicts:
    {rule_id, rule_name, category, status, applicability, progress,
     explanation, frequency, authority, documents, source, act_section,
     jurisdiction, last_verified_date, needs_verification}
    """
    if rules is None:
        rules = load_compliance_rules()

    results = []
    for rule in rules:
        matched_group = None
        for group in rule.get("condition_groups", []):
            if _condition_group_matches(group, profile):
                matched_group = group
                break

        applicable = matched_group is not None
        explanation = _explain(rule, matched_group, profile)

        if rule.get("needs_verification"):
            applicability = "Needs verification"
            progress = "Action required"
            status = "Needs Verification"
        elif applicable:
            applicability = "Applicable"
            flag_field = REGISTRATION_FLAG_FOR_RULE.get(rule["id"])
            if flag_field and profile.get(flag_field):
                progress = "Completed"
                status = "Applicable — Already Registered"
            else:
                progress = "Action required"
                status = "Applicable — Action Required" if flag_field else "Applicable"
        else:
            applicability = "Not applicable"
            progress = "Not applicable"
            status = "Not Applicable"

        results.append({
            "rule_id": rule["id"],
            "rule_name": rule["name"],
            "category": rule["category"],
            "status": status,
            "applicability": applicability,
            "progress": progress,
            "explanation": explanation,
            "frequency": rule.get("frequency"),
            "authority": rule.get("authority"),
            "documents": rule.get("documents", []),
            "source": rule.get("source"),
            "act_section": rule.get("act_section"),
            "jurisdiction": rule.get("jurisdiction"),
            "last_verified_date": rule.get("last_verified_date"),
            "needs_verification": rule.get("needs_verification", False),
            "registration_steps": rule.get("registration_steps", []),
        })

    return results
