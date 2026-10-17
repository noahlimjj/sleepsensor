import time, subprocess
from AppKit import NSWorkspace, NSApplicationActivateIgnoringOtherApps
from Quartz.CoreGraphics import (
    CGEventCreateMouseEvent, CGEventPost, kCGHIDEventTap,
    kCGEventMouseMoved, kCGEventLeftMouseDown, kCGEventLeftMouseUp,
    CGEventCreateKeyboardEvent, CGEventSetFlags, kCGEventFlagMaskCommand, CGPoint
)

# 1. Activate Chrome
for app in NSWorkspace.sharedWorkspace().runningApplications():
    if app.bundleIdentifier() == 'com.google.Chrome':
        app.activateWithOptions_(NSApplicationActivateIgnoringOtherApps)
        break

time.sleep(0.8)

def click(x, y):
    point = CGPoint(x, y)
    m = CGEventCreateMouseEvent(None, kCGEventMouseMoved, point, 0)
    CGEventPost(kCGHIDEventTap, m)
    time.sleep(0.1)
    d = CGEventCreateMouseEvent(None, kCGEventLeftMouseDown, point, 0)
    CGEventPost(kCGHIDEventTap, d)
    time.sleep(0.1)
    u = CGEventCreateMouseEvent(None, kCGEventLeftMouseUp, point, 0)
    CGEventPost(kCGHIDEventTap, u)
    time.sleep(0.2)

print("Clicking 'Reply to App Review' at (297, 640)...")
click(297, 640)
time.sleep(1.2)

print("Focusing textarea in modal...")
click(500, 570)
time.sleep(0.5)

print("Sending Cmd+V via System Events...")
cmd = """osascript -e 'tell application "System Events" to keystroke "v" using {command down}'"""
subprocess.run(cmd, shell=True, check=True)
time.sleep(1.5)

print("Done pasting!")
