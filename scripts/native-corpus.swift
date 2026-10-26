import Foundation
import ImageIO
import CoreGraphics
let root=URL(fileURLWithPath:CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/heic-external-corpus")
let names=try FileManager.default.contentsOfDirectory(atPath:root.path).filter{$0.hasSuffix(".heic")||$0.hasSuffix(".heif")}.sorted()
for name in names { autoreleasepool {
 var row:[String:Any]=["name":name]
 if let source=CGImageSourceCreateWithURL(root.appendingPathComponent(name) as CFURL,nil){
  let primary=CGImageSourceGetPrimaryImageIndex(source)
  let props=CGImageSourceCopyPropertiesAtIndex(source,primary,nil) as? [CFString:Any]
  let w=(props?[kCGImagePropertyPixelWidth] as? Int) ?? 0,h=(props?[kCGImagePropertyPixelHeight] as? Int) ?? 0
  row["orientation"]=(props?[kCGImagePropertyOrientation] as? Int) ?? 1
  if w*h>50_000_000{row["status"]="resource-skip"}
  else if let image=CGImageSourceCreateImageAtIndex(source,primary,nil){row["status"]="decoded";row["width"]=image.width;row["height"]=image.height}
  else{row["status"]="rejected"}
 }else{row["status"]="rejected"}
 let data=try! JSONSerialization.data(withJSONObject:row,options:[.sortedKeys]);print(String(data:data,encoding:.utf8)!)
}}
