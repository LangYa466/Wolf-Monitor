package collector
import ("testing";"github.com/shirou/gopsutil/v4/net")
func TestSmoke(t *testing.T){
 s,r,_ := netTotals(); all,_ := net.IOCounters(false)
 t.Logf("picked  sent=%.1fGiB recv=%.1fGiB", float64(s)/(1<<30), float64(r)/(1<<30))
 t.Logf("all-if  sent=%.1fGiB recv=%.1fGiB", float64(all[0].BytesSent)/(1<<30), float64(all[0].BytesRecv)/(1<<30))
}
