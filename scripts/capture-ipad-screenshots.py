import http.server, socketserver, threading, time, os
from playwright.sync_api import sync_playwright
from PIL import Image

output_dir = '/private/tmp/screenshots_ipad'
os.makedirs(output_dir, exist_ok=True)

PORT = 8794
Handler = http.server.SimpleHTTPRequestHandler
httpd = socketserver.TCPServer(('', PORT), Handler)
t = threading.Thread(target=httpd.serve_forever)
t.daemon = True
t.start()
print(f"Local server started on port {PORT}")

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(
        viewport={'width': 1024, 'height': 1366},
        device_scale_factor=2,
        user_agent='Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    )
    page = context.new_page()
    page.goto(f'http://localhost:{PORT}/index.html')
    page.wait_for_selector('#app', state='attached')

    # Ensure app is visible and auth is closed
    page.evaluate("""() => {
        const auth = document.getElementById('auth-screen');
        if (auth) auth.hidden = true;
        const app = document.getElementById('app');
        if (app) app.hidden = false;
    }""")
    time.sleep(1)

    # --- SCREENSHOT 1: Live Monitoring ---
    page.evaluate("""() => {
        document.getElementById('stat-elapsed').textContent = '05:42:18';
        document.getElementById('stat-snoring-count').textContent = '14';
        document.getElementById('stat-bruxism-count').textContent = '6';
        document.getElementById('stat-noise-count').textContent = '3';
        
        const meter = document.getElementById('live-db-meter');
        if (meter) {
            meter.hidden = false;
            const dbVal = document.getElementById('db-value');
            if (dbVal) dbVal.textContent = '46 dB';
        }
        
        const label = document.querySelector('.waveform-label');
        if (label) label.textContent = 'Monitoring Sound • 100% On-Device';
        
        const statusEl = document.getElementById('status-text');
        if (statusEl) statusEl.textContent = 'Audio Monitoring Active';
    }""")
    time.sleep(1)
    s1_path = os.path.join(output_dir, '1_ipad_live_monitoring.png')
    page.screenshot(path=s1_path)
    print("iPad Screenshot 1 captured:", s1_path, Image.open(s1_path).size)

    # --- SCREENSHOT 2: Analytics & Sleep Health ---
    page.evaluate("""() => {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const anScreen = document.getElementById('screen-analytics');
        if (anScreen) anScreen.classList.add('active');
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        const anBtn = document.getElementById('nav-analytics');
        if (anBtn) anBtn.classList.add('active');
        
        const emptyState = document.getElementById('analytics-empty');
        if (emptyState) emptyState.hidden = true;
        const score = document.getElementById('sleep-score-value');
        if (score) score.textContent = '88';
        const snorePct = document.getElementById('snoring-percentage');
        if (snorePct) snorePct.textContent = '11%';
        const grindCount = document.getElementById('bruxism-episodes');
        if (grindCount) grindCount.textContent = '6';
        const noiseCount = document.getElementById('noise-spikes');
        if (noiseCount) noiseCount.textContent = '3';
        const dur = document.getElementById('total-duration');
        if (dur) dur.textContent = '7h 42m';
    }""")
    time.sleep(1)
    s2_path = os.path.join(output_dir, '2_ipad_analytics_dashboard.png')
    page.screenshot(path=s2_path)
    print("iPad Screenshot 2 captured:", s2_path, Image.open(s2_path).size)

    # --- SCREENSHOT 3: Overnight History & Trends ---
    page.evaluate("""() => {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const histScreen = document.getElementById('screen-history');
        if (histScreen) histScreen.classList.add('active');
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        const histBtn = document.getElementById('nav-history');
        if (histBtn) histBtn.classList.add('active');
        
        const emptyHist = document.getElementById('history-empty');
        if (emptyHist) emptyHist.hidden = true;
        const list = document.getElementById('history-list');
        if (list) {
            list.innerHTML = `
                <div style="display:flex; flex-direction:column; gap:14px; max-width:800px; margin:0 auto;">
                    <div style="background:var(--card); border:1px solid var(--border); border-radius:16px; padding:20px; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <div style="font-size:17px; font-weight:600;">Last Night (Tue, Oct 13)</div>
                            <div style="font-size:14px; color:var(--muted); margin-top:4px;">7h 42m sleep • 48m snore • 22m grind</div>
                        </div>
                        <div style="background:rgba(34,197,94,0.15); color:#4ade80; padding:6px 14px; border-radius:10px; font-size:14px; font-weight:600;">Good</div>
                    </div>
                    <div style="background:var(--card); border:1px solid var(--border); border-radius:16px; padding:20px; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <div style="font-size:17px; font-weight:600;">Mon, Oct 12</div>
                            <div style="font-size:14px; color:var(--muted); margin-top:4px;">8h 05m sleep • 32m snore • 12m grind</div>
                        </div>
                        <div style="background:rgba(34,197,94,0.15); color:#4ade80; padding:6px 14px; border-radius:10px; font-size:14px; font-weight:600;">Optimal</div>
                    </div>
                    <div style="background:var(--card); border:1px solid var(--border); border-radius:16px; padding:20px; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <div style="font-size:17px; font-weight:600;">Sun, Oct 11</div>
                            <div style="font-size:14px; color:var(--muted); margin-top:4px;">6h 50m sleep • 65m snore • 28m grind</div>
                        </div>
                        <div style="background:rgba(245,158,11,0.15); color:#fbbf24; padding:6px 14px; border-radius:10px; font-size:14px; font-weight:600;">Moderate</div>
                    </div>
                    <div style="background:var(--card); border:1px solid var(--border); border-radius:16px; padding:20px; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <div style="font-size:17px; font-weight:600;">Sat, Oct 10</div>
                            <div style="font-size:14px; color:var(--muted); margin-top:4px;">7h 30m sleep • 24m snore • 18m grind</div>
                        </div>
                        <div style="background:rgba(34,197,94,0.15); color:#4ade80; padding:6px 14px; border-radius:10px; font-size:14px; font-weight:600;">Good</div>
                    </div>
                </div>
            `;
        }
    }""")
    time.sleep(1)
    s3_path = os.path.join(output_dir, '3_ipad_history_trends.png')
    page.screenshot(path=s3_path)
    print("iPad Screenshot 3 captured:", s3_path, Image.open(s3_path).size)

    # --- SCREENSHOT 4: Settings & On-Device Privacy ---
    page.evaluate("""() => {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const sett = document.getElementById('screen-settings');
        if (sett) sett.classList.add('active');
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        const settBtn = document.getElementById('nav-settings');
        if (settBtn) settBtn.classList.add('active');
    }""")
    time.sleep(1)
    s4_path = os.path.join(output_dir, '4_ipad_settings_privacy.png')
    page.screenshot(path=s4_path)
    print("iPad Screenshot 4 captured:", s4_path, Image.open(s4_path).size)

    browser.close()

httpd.shutdown()
print("All 4 iPad screenshots generated successfully!")
