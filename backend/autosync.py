"""
Scheduled sync + alerts. Enter the OTP once in the morning (the token lasts up to 8h); this job
then syncs at 11:35 and 15:05 on weekdays, sends new alerts, logs forecasts and writes the
weekly report on Fridays.

  /usr/bin/python3 backend/autosync.py run         # one pass (what launchd runs)
  /usr/bin/python3 backend/autosync.py install     # add the macOS LaunchAgent
  /usr/bin/python3 backend/autosync.py uninstall   # remove it
"""

import os
import plistlib
import subprocess
import sys
from datetime import date, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import tcbs_account as ta  # noqa: E402

LABEL = "vn.traderai.autosync"
PLIST = os.path.expanduser(f"~/Library/LaunchAgents/{LABEL}.plist")
LOG = os.path.join(ta.RUNTIME_DIR, "autosync.log")
TIMES = ((11, 35), (15, 5))


def run() -> int:
    ta._load_env()
    import agents.tools  # noqa: F401  (load the backend `agents` package before api/ joins sys.path)
    import notify
    import personal_rules
    import pipeline
    import portfolio_insights
    import weekly_report

    stamp = datetime.now().isoformat(timespec="seconds")
    if not ta.load_token():
        new = notify.fresh([{"id": "otp", "text": "🔑 Token TCBS đã hết hạn — mở TraderAI và nhập OTP để bật tự đồng bộ hôm nay."}])
        print(f"{stamp} no token; {notify.deliver(new)}")
        return 0
    try:
        snapshot = ta.sync()
    except ta.TcbsError as e:
        print(f"{stamp} sync failed: {e}")
        return 1
    analysis = ta.analyze_snapshot(snapshot)
    tickers = [h["ticker"] for h in analysis["holdings"]]
    ctx = pipeline.risk_context(analysis)
    _, companies, news = portfolio_insights.fetch_insight_data(tickers)
    sectors = {t: c.get("sectorVn") for t, c in companies.items() if c.get("sectorVn")}
    violations = personal_rules.evaluate(analysis, sectors)
    alerts = notify.collect_alerts(analysis, ctx["plan"], ctx["forecasts"], violations, news)
    result = notify.deliver(notify.fresh(alerts))
    report = None
    if date.today().weekday() == 4 and not weekly_report.read_report(weekly_report.week_id()):
        report = pipeline.weekly_report_now(analysis)["name"]
    print(f"{stamp} synced {len(tickers)} holdings; alerts {result}; report {report or '-'}")
    return 0


def install() -> None:
    os.makedirs(os.path.dirname(PLIST), exist_ok=True)
    os.makedirs(ta.RUNTIME_DIR, exist_ok=True)
    plist = {
        "Label": LABEL,
        "ProgramArguments": ["/usr/bin/python3", os.path.join(HERE, "autosync.py"), "run"],
        "WorkingDirectory": HERE,
        "StartCalendarInterval": [{"Weekday": d, "Hour": h, "Minute": m} for d in range(1, 6) for h, m in TIMES],
        "StandardOutPath": LOG,
        "StandardErrorPath": LOG,
    }
    with open(PLIST, "wb") as f:
        plistlib.dump(plist, f)
    subprocess.run(["launchctl", "unload", PLIST], capture_output=True)
    subprocess.run(["launchctl", "load", PLIST], check=True)
    print(f"Đã cài {PLIST}: chạy lúc {', '.join(f'{h:02d}:{m:02d}' for h, m in TIMES)} thứ 2–6. Log: {LOG}")


def uninstall() -> None:
    if os.path.exists(PLIST):
        subprocess.run(["launchctl", "unload", PLIST], capture_output=True)
        os.remove(PLIST)
    print("Đã gỡ lịch tự đồng bộ.")


def installed() -> bool:
    return os.path.exists(PLIST)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "install":
        install()
    elif cmd == "uninstall":
        uninstall()
    else:
        sys.exit(run())
