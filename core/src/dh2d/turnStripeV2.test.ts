import { decodeTurnStripe, TURN_STRIPE_HEIGHT } from './turnStripe'

function raster(hexes: string[]): number[] {
  const width=hexes.length*64, image=new Array(width*12).fill(16)
  hexes.forEach((hex,rep)=>{
    const bytes=Array.from(hex.matchAll(/../g),m=>parseInt(m[0],16))
    bytes.forEach((byte,i)=>{for(let bit=0;bit<8;bit++){
      const n=i*8+bit, row=Math.floor(n/16), col=n%16
      for(let y=0;y<4;y++)for(let x=0;x<4;x++)image[(row*4+y)*width+rep*64+col*4+x]=(byte>>(7-bit))&1?235:16
    }})
  })
  return image
}

test('V2 independent golden packets preserve both idle and active for the same turn',()=>{
  expect(TURN_STRIPE_HEIGHT).toBe(12)
  for(const [hex,active] of [['020041306106',false],['020141305636',true]] as const){
    const decoded:any=decodeTurnStripe(raster([hex,hex]),128)
    expect(decoded.tokens).toEqual(['A0','A0'])
    expect(decoded.packet).toEqual({turnId:'A0',rawAudioActive:active})
  }
})
test('V2 CRC-valid unsupported version, reserved flags and invalid token are not observations',()=>{
  for(const hex of ['030141302082','028041305a5c','0201213facf3']){
    const decoded:any=decodeTurnStripe(raster([hex]),64)
    expect(decoded.tokens).toEqual([]);expect(decoded.packet).toBeNull()
  }
})
test('agreeing intact copies survive damage but conflicting valid activity invalidates the frame',()=>{
  const damaged=raster(['020141305636','020141305636']);damaged[0]=235
  // Flip the entire first bit cell, not one pixel averaged away.
  for(let y=0;y<4;y++)for(let x=0;x<4;x++)damaged[y*128+x]=235
  const recovered:any=decodeTurnStripe(damaged,128)
  expect(recovered.failures).toBe(1);expect(recovered.packet).toEqual({turnId:'A0',rawAudioActive:true})
  const conflict:any=decodeTurnStripe(raster(['020041306106','020141305636']),128)
  expect(conflict.tokens).toEqual([]);expect(conflict.packet).toBeNull()
})
test('partial stripe data cannot be decoded as an idle observation',()=>{
  const decoded:any=decodeTurnStripe(raster(['020041306106']).slice(0,64*8),64)
  expect(decoded.tokens).toEqual([]);expect(decoded.packet).toBeNull()
})
