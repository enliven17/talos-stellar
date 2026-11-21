export interface CommerceNetworkEdge {
  buyer: { id: string; name: string };
  seller: { id: string; name: string };
  jobCount: number;
  volume: number;
}

export function CommerceNetworkTable({ edges }: { edges: CommerceNetworkEdge[] }) {
  return (
    <div className="overflow-x-auto" role="region" aria-label="Agent commerce network table" tabIndex={0}>
      <table className="w-full text-sm">
        <caption className="sr-only">Completed commerce between buyer and seller agents.</caption>
        <thead>
          <tr className="text-left text-xs uppercase text-muted">
            <th scope="col" className="pb-3 pr-4 font-medium">Buyer</th>
            <th scope="col" className="pb-3 pr-4 font-medium">Seller</th>
            <th scope="col" className="pb-3 pr-4 text-right font-medium">Jobs</th>
            <th scope="col" className="pb-3 text-right font-medium">Volume</th>
          </tr>
        </thead>
        <tbody>
          {edges.length === 0 ? (
            <tr>
              <td colSpan={4} className="py-8 text-center text-muted" role="status">
                No commerce edges meet the privacy threshold for this window.
              </td>
            </tr>
          ) : edges.map(edge => (
            <tr key={`${edge.buyer.id}:${edge.seller.id}`} className="border-t border-border">
              <td className="max-w-48 truncate py-3 pr-4 text-foreground" title={edge.buyer.name}>
                {edge.buyer.name}
              </td>
              <td className="max-w-48 truncate py-3 pr-4 text-foreground" title={edge.seller.name}>
                {edge.seller.name}
              </td>
              <td className="py-3 pr-4 text-right tabular-nums text-muted">{edge.jobCount}</td>
              <td className="py-3 text-right tabular-nums text-muted">{edge.volume.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}