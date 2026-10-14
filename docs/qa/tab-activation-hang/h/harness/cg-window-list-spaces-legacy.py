import ctypes,plistlib,json,sys
cf=ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
cg=ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
cg.CGWindowListCopyWindowInfo.argtypes=[ctypes.c_uint32,ctypes.c_uint32];cg.CGWindowListCopyWindowInfo.restype=ctypes.c_void_p
cf.CFPropertyListCreateData.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_long,ctypes.c_ulong,ctypes.c_void_p];cf.CFPropertyListCreateData.restype=ctypes.c_void_p
cf.CFDataGetLength.argtypes=[ctypes.c_void_p];cf.CFDataGetLength.restype=ctypes.c_long
cf.CFDataGetBytePtr.argtypes=[ctypes.c_void_p];cf.CFDataGetBytePtr.restype=ctypes.c_void_p
cf.CFRelease.argtypes=[ctypes.c_void_p]
a=cg.CGWindowListCopyWindowInfo(0,0);d=cf.CFPropertyListCreateData(None,a,100,0,None)
rows=plistlib.loads(ctypes.string_at(cf.CFDataGetBytePtr(d),cf.CFDataGetLength(d)));cf.CFRelease(d);cf.CFRelease(a)
pids=set(map(int,sys.argv[1:]));result=[]
for index,row in enumerate(rows):
 if row.get('kCGWindowOwnerPID') in pids:
  result.append({'zIndex':index,'pid':row.get('kCGWindowOwnerPID'),'windowId':row.get('kCGWindowNumber'),'layer':row.get('kCGWindowLayer'),'bounds':row.get('kCGWindowBounds'),'onScreen':row.get('kCGWindowIsOnscreen'),'alpha':row.get('kCGWindowAlpha'),'title':row.get('kCGWindowName')})
print(json.dumps({'windows':result}))
