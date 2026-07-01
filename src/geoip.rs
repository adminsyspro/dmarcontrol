use std::net::IpAddr;
use std::path::Path;

use maxminddb::{path, Reader};

#[derive(Debug, Clone)]
pub struct GeoLocation {
    pub provider: &'static str,
    pub country: String,
    pub country_code: Option<String>,
    pub region: String,
    pub continent: Option<String>,
    pub continent_code: Option<String>,
    pub asn_number: Option<u64>,
    pub asn_organization: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
}

pub struct GeoIpResolver {
    reader: Reader<Vec<u8>>,
}

impl GeoIpResolver {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, maxminddb::MaxMindDbError> {
        Ok(Self {
            reader: Reader::open_readfile(path)?,
        })
    }

    pub fn lookup(&self, source_ip: &str) -> Option<GeoLocation> {
        let ip: IpAddr = source_ip.parse().ok()?;
        let result = self.reader.lookup(ip).ok()?;
        let country_name: Option<String> = result
            .decode_path(&path!["country", "names", "en"])
            .ok()
            .flatten()
            .or_else(|| result.decode_path(&path!["country", "name"]).ok().flatten());
        let country_code: Option<String> = result
            .decode_path(&path!["country", "iso_code"])
            .ok()
            .flatten()
            .map(|code: String| code.to_uppercase());
        let continent: Option<String> = result
            .decode_path(&path!["continent", "names", "en"])
            .ok()
            .flatten()
            .or_else(|| {
                result
                    .decode_path(&path!["continent", "name"])
                    .ok()
                    .flatten()
            });
        let continent_code: Option<String> = result
            .decode_path(&path!["continent", "code"])
            .ok()
            .flatten();
        let asn_number = result
            .decode_path::<u64>(&path!["autonomous_system_number"])
            .ok()
            .flatten()
            .or_else(|| {
                result
                    .decode_path::<u32>(&path!["autonomous_system_number"])
                    .ok()
                    .flatten()
                    .map(u64::from)
            })
            .or_else(|| {
                result
                    .decode_path::<u64>(&path!["asn", "number"])
                    .ok()
                    .flatten()
            })
            .or_else(|| {
                result
                    .decode_path::<u32>(&path!["asn", "number"])
                    .ok()
                    .flatten()
                    .map(u64::from)
            });
        let asn_organization: Option<String> = result
            .decode_path(&path!["autonomous_system_organization"])
            .ok()
            .flatten()
            .or_else(|| {
                result
                    .decode_path(&path!["asn", "organization"])
                    .ok()
                    .flatten()
            });
        let (latitude, longitude) = country_code
            .as_deref()
            .and_then(country_centroid)
            .or_else(|| continent_code.as_deref().and_then(continent_centroid))?;
        let country_name = country_name
            .or_else(|| country_code.as_deref().map(country_name_from_code))
            .unwrap_or_else(|| "Unknown".to_string());

        Some(GeoLocation {
            provider: "IP66",
            country: country_name,
            country_code,
            region: "Country-level".to_string(),
            continent,
            continent_code,
            asn_number,
            asn_organization,
            latitude,
            longitude,
        })
    }
}

pub fn fallback_location(
    country: &'static str,
    country_code: &'static str,
    region: &'static str,
    latitude: f64,
    longitude: f64,
) -> GeoLocation {
    GeoLocation {
        provider: "local fallback",
        country: country.to_string(),
        country_code: Some(country_code.to_string()),
        region: region.to_string(),
        continent: None,
        continent_code: None,
        asn_number: None,
        asn_organization: None,
        latitude,
        longitude,
    }
}

fn continent_centroid(code: &str) -> Option<(f64, f64)> {
    match code {
        "AF" => Some((1.6508, 17.6791)),
        "AN" => Some((-82.8628, 135.0)),
        "AS" => Some((34.0479, 100.6197)),
        "EU" => Some((54.526, 15.2551)),
        "NA" => Some((54.526, -105.2551)),
        "OC" => Some((-22.7359, 140.0188)),
        "SA" => Some((-8.7832, -55.4915)),
        _ => None,
    }
}

fn country_centroid(code: &str) -> Option<(f64, f64)> {
    match code {
        "AD" => Some((42.5063, 1.5218)),
        "AE" => Some((23.4241, 53.8478)),
        "AF" => Some((33.9391, 67.71)),
        "AG" => Some((17.0608, -61.7964)),
        "AL" => Some((41.1533, 20.1683)),
        "AM" => Some((40.0691, 45.0382)),
        "AO" => Some((-11.2027, 17.8739)),
        "AR" => Some((-38.4161, -63.6167)),
        "AT" => Some((47.5162, 14.5501)),
        "AU" => Some((-25.2744, 133.7751)),
        "AZ" => Some((40.1431, 47.5769)),
        "BA" => Some((43.9159, 17.6791)),
        "BD" => Some((23.685, 90.3563)),
        "BE" => Some((50.5039, 4.4699)),
        "BF" => Some((12.2383, -1.5616)),
        "BG" => Some((42.7339, 25.4858)),
        "BH" => Some((25.9304, 50.6378)),
        "BI" => Some((-3.3731, 29.9189)),
        "BJ" => Some((9.3077, 2.3158)),
        "BN" => Some((4.5353, 114.7277)),
        "BO" => Some((-16.2902, -63.5887)),
        "BR" => Some((-14.235, -51.9253)),
        "BS" => Some((25.0343, -77.3963)),
        "BT" => Some((27.5142, 90.4336)),
        "BW" => Some((-22.3285, 24.6849)),
        "BY" => Some((53.7098, 27.9534)),
        "BZ" => Some((17.1899, -88.4976)),
        "CA" => Some((56.1304, -106.3468)),
        "CD" => Some((-4.0383, 21.7587)),
        "CF" => Some((6.6111, 20.9394)),
        "CG" => Some((-0.228, 15.8277)),
        "CH" => Some((46.8182, 8.2275)),
        "CI" => Some((7.54, -5.5471)),
        "CL" => Some((-35.6751, -71.543)),
        "CM" => Some((7.3697, 12.3547)),
        "CN" => Some((35.8617, 104.1954)),
        "CO" => Some((4.5709, -74.2973)),
        "CR" => Some((9.7489, -83.7534)),
        "CU" => Some((21.5218, -77.7812)),
        "CY" => Some((35.1264, 33.4299)),
        "CZ" => Some((49.8175, 15.473)),
        "DE" => Some((51.1657, 10.4515)),
        "DK" => Some((56.2639, 9.5018)),
        "DO" => Some((18.7357, -70.1627)),
        "DZ" => Some((28.0339, 1.6596)),
        "EC" => Some((-1.8312, -78.1834)),
        "EE" => Some((58.5953, 25.0136)),
        "EG" => Some((26.8206, 30.8025)),
        "ES" => Some((40.4637, -3.7492)),
        "ET" => Some((9.145, 40.4897)),
        "FI" => Some((61.9241, 25.7482)),
        "FJ" => Some((-16.5782, 179.4144)),
        "FR" => Some((46.2276, 2.2137)),
        "GB" => Some((55.3781, -3.436)),
        "GE" => Some((42.3154, 43.3569)),
        "GH" => Some((7.9465, -1.0232)),
        "GR" => Some((39.0742, 21.8243)),
        "GT" => Some((15.7835, -90.2308)),
        "HK" => Some((22.3193, 114.1694)),
        "HN" => Some((15.2, -86.2419)),
        "HR" => Some((45.1, 15.2)),
        "HT" => Some((18.9712, -72.2852)),
        "HU" => Some((47.1625, 19.5033)),
        "ID" => Some((-0.7893, 113.9213)),
        "IE" => Some((53.4129, -8.2439)),
        "IL" => Some((31.0461, 34.8516)),
        "IN" => Some((20.5937, 78.9629)),
        "IQ" => Some((33.2232, 43.6793)),
        "IR" => Some((32.4279, 53.688)),
        "IS" => Some((64.9631, -19.0208)),
        "IT" => Some((41.8719, 12.5674)),
        "JM" => Some((18.1096, -77.2975)),
        "JO" => Some((30.5852, 36.2384)),
        "JP" => Some((36.2048, 138.2529)),
        "KE" => Some((-0.0236, 37.9062)),
        "KG" => Some((41.2044, 74.7661)),
        "KH" => Some((12.5657, 104.991)),
        "KR" => Some((35.9078, 127.7669)),
        "KW" => Some((29.3117, 47.4818)),
        "KZ" => Some((48.0196, 66.9237)),
        "LA" => Some((19.8563, 102.4955)),
        "LB" => Some((33.8547, 35.8623)),
        "LK" => Some((7.8731, 80.7718)),
        "LT" => Some((55.1694, 23.8813)),
        "LU" => Some((49.8153, 6.1296)),
        "LV" => Some((56.8796, 24.6032)),
        "LY" => Some((26.3351, 17.2283)),
        "MA" => Some((31.7917, -7.0926)),
        "MD" => Some((47.4116, 28.3699)),
        "MG" => Some((-18.7669, 46.8691)),
        "MK" => Some((41.6086, 21.7453)),
        "ML" => Some((17.5707, -3.9962)),
        "MM" => Some((21.9162, 95.956)),
        "MN" => Some((46.8625, 103.8467)),
        "MO" => Some((22.1987, 113.5439)),
        "MT" => Some((35.9375, 14.3754)),
        "MU" => Some((-20.3484, 57.5522)),
        "MX" => Some((23.6345, -102.5528)),
        "MY" => Some((4.2105, 101.9758)),
        "MZ" => Some((-18.6657, 35.5296)),
        "NA" => Some((-22.9576, 18.4904)),
        "NG" => Some((9.082, 8.6753)),
        "NI" => Some((12.8654, -85.2072)),
        "NL" => Some((52.1326, 5.2913)),
        "NO" => Some((60.472, 8.4689)),
        "NP" => Some((28.3949, 84.124)),
        "NZ" => Some((-40.9006, 174.886)),
        "OM" => Some((21.5126, 55.9233)),
        "PA" => Some((8.538, -80.7821)),
        "PE" => Some((-9.19, -75.0152)),
        "PH" => Some((12.8797, 121.774)),
        "PK" => Some((30.3753, 69.3451)),
        "PL" => Some((51.9194, 19.1451)),
        "PR" => Some((18.2208, -66.5901)),
        "PT" => Some((39.3999, -8.2245)),
        "PY" => Some((-23.4425, -58.4438)),
        "QA" => Some((25.3548, 51.1839)),
        "RO" => Some((45.9432, 24.9668)),
        "RS" => Some((44.0165, 21.0059)),
        "RU" => Some((61.524, 105.3188)),
        "SA" => Some((23.8859, 45.0792)),
        "SD" => Some((12.8628, 30.2176)),
        "SE" => Some((60.1282, 18.6435)),
        "SG" => Some((1.3521, 103.8198)),
        "SI" => Some((46.1512, 14.9955)),
        "SK" => Some((48.669, 19.699)),
        "SN" => Some((14.4974, -14.4524)),
        "SO" => Some((5.1521, 46.1996)),
        "SV" => Some((13.7942, -88.8965)),
        "SY" => Some((34.8021, 38.9968)),
        "TH" => Some((15.87, 100.9925)),
        "TN" => Some((33.8869, 9.5375)),
        "TR" => Some((38.9637, 35.2433)),
        "TW" => Some((23.6978, 120.9605)),
        "TZ" => Some((-6.369, 34.8888)),
        "UA" => Some((48.3794, 31.1656)),
        "UG" => Some((1.3733, 32.2903)),
        "US" => Some((37.0902, -95.7129)),
        "UY" => Some((-32.5228, -55.7658)),
        "UZ" => Some((41.3775, 64.5853)),
        "VE" => Some((6.4238, -66.5897)),
        "VN" => Some((14.0583, 108.2772)),
        "ZA" => Some((-30.5595, 22.9375)),
        "ZM" => Some((-13.1339, 27.8493)),
        "ZW" => Some((-19.0154, 29.1549)),
        _ => None,
    }
}

fn country_name_from_code(code: &str) -> String {
    match code {
        "FR" => "France",
        "IE" => "Ireland",
        "US" => "United States",
        "GB" => "United Kingdom",
        "DE" => "Germany",
        "ES" => "Spain",
        "IT" => "Italy",
        "NL" => "Netherlands",
        "BE" => "Belgium",
        "CH" => "Switzerland",
        "CA" => "Canada",
        "AU" => "Australia",
        "JP" => "Japan",
        "CN" => "China",
        "IN" => "India",
        "BR" => "Brazil",
        "MX" => "Mexico",
        "SG" => "Singapore",
        "ZA" => "South Africa",
        _ => code,
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{country_centroid, GeoIpResolver};

    #[test]
    fn knows_common_country_centroids() {
        assert_eq!(country_centroid("US"), Some((37.0902, -95.7129)));
        assert_eq!(country_centroid("FR"), Some((46.2276, 2.2137)));
        assert_eq!(country_centroid("IE"), Some((53.4129, -8.2439)));
    }

    #[test]
    fn reads_ip66_database_when_available() {
        let path = Path::new("data/ip66.mmdb");
        if !path.exists() {
            return;
        }

        let resolver = GeoIpResolver::open(path).expect("ip66 database should open");
        let location = resolver
            .lookup("8.8.8.8")
            .expect("ip66 database should resolve 8.8.8.8");

        assert_eq!(location.provider, "IP66");
        assert_eq!(location.country_code.as_deref(), Some("US"));
        assert!(location.asn_number.is_some());
        assert!(location.asn_organization.is_some());
    }
}
