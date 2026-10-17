import http.server, socketserver, threading, time, os
from playwright.sync_api import sync_playwright
from PIL import Image

output_dir = '/private/tmp/screenshots'
os.makedirs(output_dir, exist_ok=True)

PORT = 8792
Handler = http.server.SimpleHTTPRequestHandler
httpd = socketserver.TCPServer(('', PORT), Handler)
t = threading.Thread(target=httpd.serve_forever)
t.daemon = True
t.start()
print(f"Local server started on port {PORT}")

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(
        viewport={'width': 430, 'height': 932},
        device_scale_factor=3,
        user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
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
        if (label) label.textContent = 'Monitoring Sleep Audio...';
        
        const canvas = document.getElementById('waveform-canvas');
        if (canvas) {
            canvas.width = canvas.offsetWidth * 3;
            canvas.height = canvas.offsetHeight * 3;
            const ctx = canvas.getContext('2d');
            ctx.strokeStyle = '#6366f1';
            ctx.lineWidth = 4;
            ctx.beginPath();
            const w = canvas.width, h = canvas.height;
            for (let x = 0; x < w; x += 4) {
                const y = h / 2 + Math.sin(x * 0.03) * 35 + Math.sin(x * 0.08) * 20;
                if (x === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }

        const recBtn = document.getElementById('record-btn');
        if (recBtn) {
            recBtn.setAttribute('aria-pressed', 'true');
            const micIcon = recBtn.querySelector('.record-btn-icon--mic');
            const stopIcon = recBtn.querySelector('.record-btn-icon--stop');
            if (micIcon) micIcon.hidden = true;
            if (stopIcon) stopIcon.hidden = false;
        }
        const recLabel = document.getElementById('record-btn-label');
        if (recLabel) recLabel.textContent = 'Overnight Tracking Active';
    }""")
    time.sleep(1)
    s1_path = os.path.join(output_dir, '1_live_monitoring.png')
    page.screenshot(path=s1_path)
    print("Screenshot 1 captured:", s1_path, Image.open(s1_path).size)

    # --- SCREENSHOT 2: Morning Report ---
    page.evaluate("""() => {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const rep = document.getElementById('screen-report');
        if (rep) rep.classList.add('active');
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        const repBtn = document.getElementById('nav-report');
        if (repBtn) repBtn.classList.add('active');

        document.getElementById('report-empty').hidden = true;
        const repContent = document.getElementById('report-content');
        if (repContent) repContent.hidden = false;

        document.getElementById('report-date').textContent = 'Today, 7:15 AM';
        document.getElementById('report-sleep-time').textContent = '7h 42m';
        document.getElementById('report-snoring-time').textContent = '48m';
        document.getElementById('report-snoring-pct').textContent = '10% of sleep';
        document.getElementById('report-bruxism-time').textContent = '22m';
        document.getElementById('report-bruxism-pct').textContent = '5% of sleep';
        document.getElementById('report-noise-count').textContent = '4';
        document.getElementById('report-loudest').textContent = 'Peak: 64 dB';

        const tc = document.getElementById('timeline-canvas');
        if (tc) {
            tc.width = tc.offsetWidth * 3 || 1200;
            tc.height = 180;
            const ctx = tc.getContext('2d');
            const w = tc.width, h = tc.height;
            ctx.fillStyle = 'rgba(99, 102, 241, 0.2)';
            ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = '#f59e0b';
            ctx.fillRect(w * 0.2, 20, w * 0.12, h - 40);
            ctx.fillRect(w * 0.55, 30, w * 0.08, h - 60);
            ctx.fillRect(w * 0.78, 15, w * 0.1, h - 30);
            ctx.fillStyle = '#ef4444';
            ctx.fillRect(w * 0.35, 10, w * 0.06, h - 20);
            ctx.fillRect(w * 0.68, 25, w * 0.05, h - 50);
        }

        const sev = document.getElementById('severity-bars');
        if (sev) {
            sev.innerHTML = `
                <div style="margin-bottom:12px;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:13px;">
                        <span>Snoring (Mild)</span><span>48 mins</span>
                    </div>
                    <div style="background:rgba(255,255,255,0.1); border-radius:6px; height:8px; overflow:hidden;">
                        <div style="background:#f59e0b; width:28%; height:100%; border-radius:6px;"></div>
                    </div>
                </div>
                <div>
                    <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:13px;">
                        <span>Bruxism / Grinding (Low)</span><span>22 mins</span>
                    </div>
                    <div style="background:rgba(255,255,255,0.1); border-radius:6px; height:8px; overflow:hidden;">
                        <div style="background:#ef4444; width:14%; height:100%; border-radius:6px;"></div>
                    </div>
                </div>
            `;
        }

        const hEmpty = document.getElementById('highlights-empty');
        if (hEmpty) hEmpty.hidden = true;
        const hCar = document.getElementById('highlights-carousel');
        if (hCar) {
            hCar.innerHTML = `
                <div style="display:flex; gap:12px; overflow-x:auto; padding:4px;">
                    <div style="background:rgba(245,158,11,0.15); border:1px solid rgba(245,158,11,0.3); border-radius:12px; padding:12px; min-width:160px;">
                        <div style="font-size:12px; color:#f59e0b; font-weight:600;">😴 Snore Episode</div>
                        <div style="font-size:16px; font-weight:700; margin:4px 0;">02:34 AM</div>
                        <div style="font-size:12px; opacity:0.8;">61 dB • 8.4s</div>
                        <button style="margin-top:8px; background:#f59e0b; color:#000; border:none; border-radius:6px; padding:4px 10px; font-size:11px; font-weight:600;">▶ Play Clip</button>
                    </div>
                    <div style="background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.3); border-radius:12px; padding:12px; min-width:160px;">
                        <div style="font-size:12px; color:#ef4444; font-weight:600;">😬 Teeth Grinding</div>
                        <div style="font-size:16px; font-weight:700; margin:4px 0;">04:12 AM</div>
                        <div style="font-size:12px; opacity:0.8;">58 dB • 4.2s</div>
                        <button style="margin-top:8px; background:#ef4444; color:#fff; border:none; border-radius:6px; padding:4px 10px; font-size:11px; font-weight:600;">▶ Play Clip</button>
                    </div>
                </div>
            `;
        }
    }""")
    time.sleep(1)
    s2_path = os.path.join(output_dir, '2_morning_report.png')
    page.screenshot(path=s2_path)
    print("Screenshot 2 captured:", s2_path, Image.open(s2_path).size)

    # --- SCREENSHOT 3: History & Trends ---
    page.evaluate("""() => {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const hist = document.getElementById('screen-history');
        if (hist) hist.classList.add('active');
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        const histBtn = document.getElementById('nav-history');
        if (histBtn) histBtn.classList.add('active');

        const emptyHist = document.getElementById('history-empty');
        if (emptyHist) emptyHist.hidden = true;
        const list = document.getElementById('history-list');
        if (list) {
            list.innerHTML = `
                <div style="display:flex; flex-direction:column; gap:10px;">
                    <div style="background:var(--card); border:1px solid var(--border); border-radius:14px; padding:16px; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <div style="font-size:15px; font-weight:600;">Last Night (Tue, Oct 13)</div>
                            <div style="font-size:13px; color:var(--muted); margin-top:3px;">7h 42m sleep • 48m snore • 22m grind</div>
                        </div>
                        <div style="background:rgba(34,197,94,0.15); color:#4ade80; padding:4px 10px; border-radius:8px; font-size:12px; font-weight:600;">Good</div>
                    </div>
                    <div style="background:var(--card); border:1px solid var(--border); border-radius:14px; padding:16px; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <div style="font-size:15px; font-weight:600;">Mon, Oct 12</div>
                            <div style="font-size:13px; color:var(--muted); margin-top:3px;">8h 05m sleep • 32m snore • 12m grind</div>
                        </div>
                        <div style="background:rgba(34,197,94,0.15); color:#4ade80; padding:4px 10px; border-radius:8px; font-size:12px; font-weight:600;">Optimal</div>
                    </div>
                    <div style="background:var(--card); border:1px solid var(--border); border-radius:14px; padding:16px; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <div style="font-size:15px; font-weight:600;">Sun, Oct 11</div>
                            <div style="font-size:13px; color:var(--muted); margin-top:3px;">6h 50m sleep • 65m snore • 28m grind</div>
                        </div>
                        <div style="background:rgba(245,158,11,0.15); color:#fbbf24; padding:4px 10px; border-radius:8px; font-size:12px; font-weight:600;">Moderate</div>
                    </div>
                    <div style="background:var(--card); border:1px solid var(--border); border-radius:14px; padding:16px; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <div style="font-size:15px; font-weight:600;">Sat, Oct 10</div>
                            <div style="font-size:13px; color:var(--muted); margin-top:3px;">7h 30m sleep • 24m snore • 18m grind</div>
                        </div>
                        <div style="background:rgba(34,197,94,0.15); color:#4ade80; padding:4px 10px; border-radius:8px; font-size:12px; font-weight:600;">Good</div>
                    </div>
                </div>
            `;
        }
    }""")
    time.sleep(1)
    s3_path = os.path.join(output_dir, '3_history_trends.png')
    page.screenshot(path=s3_path)
    print("Screenshot 3 captured:", s3_path, Image.open(s3_path).size)

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
    s4_path = os.path.join(output_dir, '4_settings_privacy.png')
    page.screenshot(path=s4_path)
    print("Screenshot 4 captured:", s4_path, Image.open(s4_path).size)

    browser.close()

httpd.shutdown()
print("All 4 App Store screenshots generated successfully!")
