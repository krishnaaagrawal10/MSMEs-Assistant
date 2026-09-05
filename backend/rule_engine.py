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
    """Build a short, reviewer-readable reason for the decision."""
    if matched_group is None:
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
    {rule_id, rule_name, category, status, explanation, frequency,
     authority, documents, source}
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

        # Refine status using the profile's own registration flags, where tracked.
        status = "Applicable" if applicable else "Not Applicable"
        flag_field = REGISTRATION_FLAG_FOR_RULE.get(rule["id"])
        if applicable and flag_field and profile.get(flag_field):
            status = "Applicable — Already Registered"
        elif applicable and flag_field and not profile.get(flag_field):
            status = "Applicable — Action Required"

        results.append({
            "rule_id": rule["id"],
            "rule_name": rule["name"],
            "category": rule["category"],
            "status": status,
            "explanation": explanation,
            "frequency": rule.get("frequency"),
            "authority": rule.get("authority"),
            "documents": rule.get("documents", []),
            "source": rule.get("source"),
            "registration_steps": rule.get("registration_steps", []),
        })

    return results
