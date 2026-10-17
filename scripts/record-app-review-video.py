import http.server, socketserver, threading, time, os, glob, subprocess
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIDEO_DIR = '/private/tmp/sleepsensor_video_temp'
os.makedirs(VIDEO_DIR, exist_ok=True)
for f in glob.glob(f'{VIDEO_DIR}/*'):
    try: os.remove(f)
    except: pass

FINAL_MP4 = os.path.expanduser('~/Desktop/SleepSensor_AppReview_Demo.mp4')
PROJECT_MP4 = os.path.join(ROOT, 'SleepSensor_AppReview_Demo.mp4')

PORT = 8795
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

httpd = socketserver.TCPServer(('', PORT), Handler)
t = threading.Thread(target=httpd.serve_forever)
t.daemon = True
t.start()
print(f"Local web server running on port {PORT}")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(
        viewport={'width': 430, 'height': 932},
        record_video_dir=VIDEO_DIR,
        record_video_size={'width': 430, 'height': 932},
        device_scale_factor=2,
        user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
    )
    page = context.new_page()

    # 1. Launch App (Show splash screen)
    print("Step 1: Launching app with splash screen...")
    page.goto(f'http://localhost:{PORT}/index.html')
    time.sleep(2.5)

    # 2. Dismiss Splash and Reveal Main App (Record Screen)
    print("Step 2: Transitioning to Record screen...")
    page.evaluate("""() => {
        const splash = document.getElementById('splash-screen');
        if (splash) splash.classList.add('hidden');
        const auth = document.getElementById('auth-screen');
        if (auth) auth.hidden = true;
        const app = document.getElementById('app');
        if (app) app.hidden = false;
        
        // Ensure record screen is active
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById('screen-record').classList.add('active');
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.getElementById('nav-record').classList.add('active');
    }""")
    time.sleep(2)

    # 3. Simulate Starting Live Monitoring Session
    print("Step 3: Starting overnight monitoring session...")
    page.evaluate("""() => {
        const recBtn = document.getElementById('record-btn');
        if (recBtn) recBtn.setAttribute('aria-pressed', 'true');
        const micIcon = document.querySelector('.record-btn-icon--mic');
        const stopIcon = document.querySelector('.record-btn-icon--stop');
        if (micIcon) micIcon.hidden = true;
        if (stopIcon) stopIcon.hidden = false;
        const recLabel = document.getElementById('record-btn-label');
        if (recLabel) recLabel.textContent = 'Overnight Tracking Active';
        
        const meter = document.getElementById('live-db-meter');
        if (meter) meter.hidden = false;
        const overlay = document.getElementById('waveform-overlay');
        if (overlay) overlay.style.display = 'none';
        
        window._simTime = 0;
        window._simInterval = setInterval(() => {
            window._simTime++;
            const m = Math.floor(window._simTime / 60).toString().padStart(2, '0');
            const s = (window._simTime % 60).toString().padStart(2, '0');
            const el = document.getElementById('stat-elapsed');
            if (el) el.textContent = `00:${m}:${s}`;
            
            // Fluctuating dB
            const dbVal = document.getElementById('db-value');
            if (dbVal) {
                const db = 38 + Math.floor(Math.sin(window._simTime * 1.5) * 8 + Math.random() * 6);
                dbVal.textContent = `${db} dB`;
            }
            
            // Counts
            if (window._simTime >= 3) {
                const snoreEl = document.getElementById('stat-snoring-count');
                if (snoreEl) snoreEl.textContent = '1';
            }
            
            // Draw animated waveform
            const canvas = document.getElementById('waveform-canvas');
            if (canvas) {
                canvas.width = canvas.offsetWidth * 2;
                canvas.height = canvas.offsetHeight * 2;
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.strokeStyle = '#6366f1';
                ctx.lineWidth = 3;
                ctx.beginPath();
                const w = canvas.width, h = canvas.height;
                const freq = 0.04;
                const t = window._simTime * 2;
                for (let x = 0; x < w; x += 3) {
                    const y = h / 2 + Math.sin(x * freq + t) * (15 + Math.random() * 20);
                    if (x === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
        }, 300);
    }""")
    time.sleep(6)

    # 4. Stop Recording Session
    print("Step 4: Stopping monitoring session...")
    page.evaluate("""() => {
        clearInterval(window._simInterval);
        const recBtn = document.getElementById('record-btn');
        if (recBtn) recBtn.setAttribute('aria-pressed', 'false');
        const micIcon = document.querySelector('.record-btn-icon--mic');
        const stopIcon = document.querySelector('.record-btn-icon--stop');
        if (micIcon) micIcon.hidden = false;
        if (stopIcon) stopIcon.hidden = true;
        const recLabel = document.getElementById('record-btn-label');
        if (recLabel) recLabel.textContent = 'Session Complete • Report Ready';
    }""")
    time.sleep(2)

    # 5. Navigate to Morning Report
    print("Step 5: Navigating to Morning Report...")
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
            tc.width = tc.offsetWidth * 2 || 800;
            tc.height = 160;
            const ctx = tc.getContext('2d');
            const w = tc.width, h = tc.height;
            ctx.fillStyle = 'rgba(99, 102, 241, 0.15)';
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
    time.sleep(2)

    # Scroll report down and up
    page.evaluate("window.scrollTo({ top: 300, behavior: 'smooth' })")
    time.sleep(2)
    page.evaluate("window.scrollTo({ top: 0, behavior: 'smooth' })")
    time.sleep(1.5)

    # 6. Navigate to History
    print("Step 6: Navigating to History...")
    page.evaluate("""() => {
        window.scrollTo(0, 0);
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
                </div>
            `;
        }
    }""")
    time.sleep(3)

    # 7. Navigate to Settings (Demonstrate On-Device Controls & Data Clearing)
    print("Step 7: Navigating to Settings...")
    page.evaluate("""() => {
        window.scrollTo(0, 0);
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const sett = document.getElementById('screen-settings');
        if (sett) sett.classList.add('active');
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        const settBtn = document.getElementById('nav-settings');
        if (settBtn) settBtn.classList.add('active');

        const sens = document.getElementById('setting-sensitivity');
        if (sens) sens.value = 65;
        const sensDesc = document.getElementById('setting-sensitivity-desc');
        if (sensDesc) sensDesc.textContent = 'High';
        const sensDet = document.getElementById('setting-sensitivity-detail');
        if (sensDet) sensDet.textContent = 'Captures quiet breathing sounds and light snoring.';
        
        const storageUsed = document.getElementById('setting-storage-used');
        if (storageUsed) storageUsed.textContent = '1.4 MB (All local on this iPhone)';
    }""")
    time.sleep(3)

    print("Closing browser context to finalize recording...")
    page.close()
    context.close()
    browser.close()

httpd.shutdown()
print("Web server stopped.")

# Find recorded WebM file
webm_files = glob.glob(f'{VIDEO_DIR}/*.webm')
if webm_files:
    raw_webm = webm_files[0]
    print(f"Recorded raw WebM: {raw_webm} ({os.path.getsize(raw_webm)} bytes)")
    
    # Transcode to standard high-compatibility MP4
    cmd = [
        'ffmpeg', '-y', '-i', raw_webm,
        '-c:v', 'libx264', '-profile:v', 'main', '-level', '3.1',
        '-pix_fmt', 'yuv420p', '-r', '30',
        FINAL_MP4
    ]
    subprocess.run(cmd, check=True)
    subprocess.run(['cp', FINAL_MP4, PROJECT_MP4], check=True)
    print(f"Successfully generated Demo Video: {FINAL_MP4} ({os.path.getsize(FINAL_MP4)} bytes)")
else:
    print("Error: No WebM recording found.")
