"""
Stage 6 deliverable: test-case table and results.

Run directly (no server needed):
    python test_engine.py

Runs 5 representative MSME profiles through the rule engine and prints how
many compliance items are Applicable for each — proving the core Review-1
success criterion: different business profiles produce different results.
"""

from rule_engine import evaluate_profile

TEST_PROFILES = [
    {
        "label": "TC1 - Micro manufacturer, 4 employees, low turnover",
        "profile": {
            "business_type": "Manufacturing", "industry": "Textile Manufacturing",
            "state": "Tamil Nadu", "employees": 4, "turnover_lakhs": 15,
            "uses_power": True, "gst_registered": False,
            "udyam_registered": False, "factory_status": False,
        },
    },
    {
        "label": "TC2 - Small manufacturer, 15 employees, uses power",
        "profile": {
            "business_type": "Manufacturing", "industry": "Plastic Components",
            "state": "Tamil Nadu", "employees": 15, "turnover_lakhs": 60,
            "uses_power": True, "gst_registered": True,
            "udyam_registered": True, "factory_status": False,
        },
    },
    {
        "label": "TC3 - Manufacturer, 25 employees, no power",
        "profile": {
            "business_type": "Manufacturing", "industry": "Handicrafts",
            "state": "Tamil Nadu", "employees": 25, "turnover_lakhs": 90,
            "uses_power": False, "gst_registered": True,
            "udyam_registered": True, "factory_status": True,
        },
    },
    {
        "label": "TC4 - Service business, 8 employees",
        "profile": {
            "business_type": "Service", "industry": "IT Services",
            "state": "Tamil Nadu", "employees": 8, "turnover_lakhs": 25,
            "uses_power": True, "gst_registered": True,
            "udyam_registered": False, "factory_status": False,
        },
    },
    {
        "label": "TC5 - Invalid/missing-style input (edge case)",
        "profile": {
            "business_type": "Trading", "industry": "",
            "state": "Tamil Nadu", "employees": 0, "turnover_lakhs": 0,
            "uses_power": False, "gst_registered": False,
            "udyam_registered": False, "factory_status": False,
        },
    },
]


def run():
    print(f"{'Test Case':45} {'Applicable':>10} {'Not Applicable':>15}")
    print("-" * 72)
    all_counts = []
    for case in TEST_PROFILES:
        results = evaluate_profile(case["profile"])
        applicable = [r for r in results if r["status"].startswith("Applicable")]
        not_applicable = [r for r in results if r["status"] == "Not Applicable"]
        all_counts.append(len(applicable))
        print(f"{case['label']:45} {len(applicable):>10} {len(not_applicable):>15}")

    print("-" * 72)
    if len(set(all_counts)) > 1:
        print("PASS: different profiles produced different compliance counts.")
    else:
        print("CHECK: all profiles produced the same count — review conditions.")

    print("\nSample detail — TC2 applicable items:")
    tc2_results = evaluate_profile(TEST_PROFILES[1]["profile"])
    for r in tc2_results:
        if r["status"].startswith("Applicable"):
            print(f"  [{r['rule_id']}] {r['rule_name']:45} -> {r['status']}")
            print(f"        reason: {r['explanation']}")


if __name__ == "__main__":
    run()
