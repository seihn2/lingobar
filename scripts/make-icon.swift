import AppKit
let output = CommandLine.arguments[1]
let image = NSImage(size: NSSize(width: 1024, height: 1024))
image.lockFocus()
NSColor(calibratedRed: 0.075, green: 0.10, blue: 0.12, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 32, y: 32, width: 960, height: 960), xRadius: 214, yRadius: 214).fill()
NSColor(calibratedRed: 0.19, green: 0.25, blue: 0.29, alpha: 1).setStroke()
let rim = NSBezierPath(roundedRect: NSRect(x: 42, y: 42, width: 940, height: 940), xRadius: 205, yRadius: 205)
rim.lineWidth = 4; rim.stroke()
let cyan = NSColor(calibratedRed: 0.48, green: 0.87, blue: 0.85, alpha: 1)
let white = NSColor(calibratedRed: 0.91, green: 0.94, blue: 0.94, alpha: 1)
for (index, width) in [520.0, 390.0, 460.0, 310.0].enumerated() {
  let y = 682.0 - Double(index) * 132.0
  (index == 0 ? cyan : white).setFill()
  NSBezierPath(roundedRect: NSRect(x: 298, y: y, width: width, height: 52), xRadius: 26, yRadius: 26).fill()
  cyan.withAlphaComponent(index == 0 ? 1 : 0.55).setFill()
  NSBezierPath(roundedRect: NSRect(x: 194, y: y, width: 52, height: 52), xRadius: 16, yRadius: 16).fill()
}
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
