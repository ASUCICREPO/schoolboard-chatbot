import { DISTRICTS } from "@/lib/districts";
import DistrictChatPage from "@/components/DistrictChatPage";
import { notFound } from "next/navigation";

export function generateStaticParams() {
  return DISTRICTS.map((d) => ({ districtId: d.id }));
}

interface Props {
  params: Promise<{ districtId: string }>;
}

export default async function Page({ params }: Props) {
  const { districtId } = await params;
  const district = DISTRICTS.find((d) => d.id === districtId);
  if (!district) notFound();
  return <DistrictChatPage district={district} />;
}
